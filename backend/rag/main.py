"""Draft FastAPI wrapper around ask.answer_question."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import captcha
from ask import answer_question, answer_question_stream
from quota import normalize_email

TELEMETRY_PATH = Path(__file__).resolve().parent / "telemetry.jsonl"

app = FastAPI(
    title="CIROH AI Bot v2 API",
    description="Draft API wrapping the v2 hybrid RAG pipeline",
)

# Comma-separated list, e.g. "https://d123abc.cloudfront.net,https://chat.ciroh.org".
# Falls back to local dev origins so `npm run dev` keeps working unchanged.
_default_origins = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", _default_origins).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Turn(BaseModel):
    """One earlier message of the conversation, sent back by the chat so
    follow-up questions are understood in context (not stored)."""

    role: Literal["user", "assistant"]
    text: str = Field(..., max_length=8000)


class Question(BaseModel):
    # Guardrail: an explicit max-length check on the question field, so an
    # oversized payload can't be used to pad token costs or attempt
    # injection via length (Section 9.3, "Input validation").
    text: str = Field(..., min_length=1, max_length=2000)
    session_id: Optional[str] = None
    mode: str = "hybrid"
    # Required: questions are rate limited per email per day (quota.py).
    email: str = Field(..., min_length=3, max_length=254)
    # Most recent turns last; ask.py keeps only the last few.
    history: list[Turn] = Field(default_factory=list, max_length=20)
    # Signed pass from POST /captcha/verify; required only when CAPTCHA is
    # enabled (captcha.py, docs/CAPTCHA.md).
    human_pass: Optional[str] = Field(None, max_length=1024)


def _require_email(question: Question) -> str:
    email = normalize_email(question.email)
    if email is None:
        raise HTTPException(status_code=400, detail="A valid email address is required.")
    _require_human(question.human_pass, email)
    return email


def _captcha_unavailable(exc: Exception) -> HTTPException:
    print(f"captcha: {exc}")
    return HTTPException(
        status_code=503,
        detail={"code": "captcha_unavailable", "message": "Verification is temporarily unavailable. Please try again shortly."},
    )


def _require_human(human_pass: Optional[str], email: str) -> None:
    """403 unless CAPTCHA is off or `human_pass` is valid for `email`.

    Checked before any Bedrock or database work, so a bot without a pass
    costs one Lambda invocation and nothing else."""
    if not captcha.is_enabled():
        return
    try:
        ok = captcha.check_pass(human_pass, email)
    except captcha.CaptchaUnavailableError as exc:
        raise _captcha_unavailable(exc) from exc
    if not ok:
        raise HTTPException(
            status_code=403,
            detail={"code": "captcha_required", "message": "Please confirm you are human to keep chatting."},
        )


class CaptchaVerifyRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=2048)
    email: str = Field(..., min_length=3, max_length=254)


def _client_ip(request: Request) -> Optional[str]:
    # Behind CloudFront + API Gateway the viewer's address is the first
    # X-Forwarded-For entry; Turnstile uses it only as an extra signal.
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip() or None
    return request.client.host if request.client else None


class TelemetryEvent(BaseModel):
    session_id: str
    event: str
    payload: dict[str, Any] = Field(default_factory=dict)


# Lambda's code directory is read-only, so there telemetry goes to stdout
# (CloudWatch Logs, searchable with Logs Insights) instead of a local file.
IS_LAMBDA = bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME"))


def _append_telemetry(record: dict[str, Any]) -> None:
    record = {"ts": datetime.now(timezone.utc).isoformat(), **record}
    line = json.dumps(record, ensure_ascii=False)
    if IS_LAMBDA:
        print(f"TELEMETRY {line}")
        return
    with TELEMETRY_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def _warm_database() -> None:
    """Start resuming a scaled-to-zero Aurora cluster without waiting for it.

    Called when the chat panel opens, so the ~15s resume overlaps with the
    user typing their first question instead of delaying the answer.
    """
    if os.getenv("DB_BACKEND", "").lower() != "rds_data_api":
        return
    from database.rds_data_client import RdsDataApiManager

    RdsDataApiManager().ping(wait_seconds=0)


@app.get("/", tags=["Health Check"])
def read_root():
    return {"status": "CIROH AI Bot v2 API is running"}


@app.get("/captcha/config", tags=["Human verification"])
def captcha_config():
    """Whether the chat must show the CAPTCHA, and the widget's public site key."""
    return captcha.public_config()


@app.post("/captcha/verify", tags=["Human verification"])
def captcha_verify(body: CaptchaVerifyRequest, request: Request):
    """Exchange a solved Turnstile token for a signed human pass bound to the email."""
    email = normalize_email(body.email)
    if email is None:
        raise HTTPException(status_code=400, detail="A valid email address is required.")
    if not captcha.is_enabled():
        return {"enabled": False, "human_pass": None, "expires_at": None}
    try:
        ok, errors = captcha.verify_token(body.token, _client_ip(request))
        if not ok:
            _append_telemetry({"event": "captcha_failed", "errors": errors})
            raise HTTPException(
                status_code=403,
                detail={"code": "captcha_failed", "message": "Verification failed. Please try again.", "errors": errors},
            )
        human_pass, expires_at = captcha.issue_pass(email)
    except captcha.CaptchaUnavailableError as exc:
        raise _captcha_unavailable(exc) from exc
    _append_telemetry({"event": "captcha_passed"})
    return {
        "enabled": True,
        "human_pass": human_pass,
        "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
    }


@app.post("/ask", tags=["AI Assistant"])
def ask_ai(question: Question):
    email = _require_email(question)
    result = answer_question(
        question.text, mode=question.mode, email=email, history=[t.model_dump() for t in question.history]
    )
    _append_telemetry(
        {
            "event": "ask",
            "session_id": question.session_id,
            "question": question.text,
            "route": result.get("route"),
            "usage": result.get("usage"),
        }
    )
    return result


@app.post("/ask/stream", tags=["AI Assistant"])
def ask_ai_stream(question: Question):
    """Same answer as /ask, streamed as newline-delimited JSON events (see
    ask.answer_question_stream) so the chat can show the answer as it is
    written. Served by the streaming Lambda behind a Function URL; API
    Gateway (which serves /ask) buffers responses and cannot stream."""

    email = _require_email(question)

    def events():
        history = [t.model_dump() for t in question.history]
        for event in answer_question_stream(question.text, mode=question.mode, email=email, history=history):
            if event["type"] == "done":
                _append_telemetry(
                    {
                        "event": "ask",
                        "streamed": True,
                        "session_id": question.session_id,
                        "question": question.text,
                        "search_question": event.get("search_question"),
                        "history_turns": len(question.history),
                        "route": event.get("route"),
                        "usage": event.get("usage"),
                    }
                )
            yield json.dumps(event, ensure_ascii=False) + "\n"

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/telemetry", tags=["Telemetry"])
def record_telemetry(event: TelemetryEvent):
    if event.event == "chat_open":
        _warm_database()
    _append_telemetry(event.model_dump())
    return {"ok": True}
