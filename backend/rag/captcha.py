"""Human verification (CAPTCHA) for the chat, using Cloudflare Turnstile.

Flow (details and setup: docs/CAPTCHA.md):

1. The chat's welcome screen shows the Turnstile widget next to the email
   field. Solving it gives the browser a one-time Turnstile token.
2. The browser sends that token and the email to POST /captcha/verify. The
   token is checked with Cloudflare's siteverify API, and on success the
   API returns a signed "human pass" bound to that email, valid for
   CAPTCHA_PASS_TTL_HOURS (24h by default).
3. Every /ask and /ask/stream request carries the pass as `human_pass`.
   Checking it is an HMAC comparison: no network call, no database, no
   per-question challenge for the visitor.

Turnstile tokens are single-use and expire after 5 minutes, which is why
they are exchanged once for a pass instead of being sent with each
question.

Off unless a Turnstile secret key is configured (TURNSTILE_SECRET_KEY, or
TURNSTILE_SECRET_ARN for a Secrets Manager secret), so local development
and the tests run without it. Once configured it fails closed: if the
secret can't be loaded, questions are refused rather than let through.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import lru_cache
from typing import Optional

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
_PASS_VERSION = 1


class CaptchaUnavailableError(RuntimeError):
    """The secret or Cloudflare's siteverify API could not be reached."""


def is_enabled() -> bool:
    return bool(os.getenv("TURNSTILE_SECRET_KEY") or os.getenv("TURNSTILE_SECRET_ARN"))


def site_key() -> Optional[str]:
    """Public key the browser widget needs; safe to hand out."""
    return os.getenv("TURNSTILE_SITE_KEY") or None


def pass_ttl_seconds() -> int:
    return int(float(os.getenv("CAPTCHA_PASS_TTL_HOURS", "24")) * 3600)


def public_config() -> dict:
    enabled = is_enabled()
    return {
        "enabled": enabled,
        "provider": "turnstile" if enabled else None,
        "site_key": site_key() if enabled else None,
    }


@lru_cache(maxsize=1)
def _secret_from_secrets_manager(arn: str) -> str:
    import boto3

    region = os.getenv("AWS_REGION") or os.getenv("AURORA_REGION") or "us-east-1"
    try:
        value = boto3.client("secretsmanager", region_name=region).get_secret_value(SecretId=arn)["SecretString"]
    except Exception as exc:  # noqa: BLE001 - any failure means "can't verify"
        raise CaptchaUnavailableError(f"could not read the Turnstile secret: {exc}") from exc
    # Either the bare key, or JSON like {"secret_key": "0x..."}.
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value.strip()
    if isinstance(parsed, dict):
        return str(parsed.get("secret_key") or parsed.get("TURNSTILE_SECRET_KEY") or "").strip()
    return str(parsed).strip()


def _secret() -> str:
    secret = os.getenv("TURNSTILE_SECRET_KEY")
    if not secret and os.getenv("TURNSTILE_SECRET_ARN"):
        secret = _secret_from_secrets_manager(os.environ["TURNSTILE_SECRET_ARN"])
    if not secret:
        raise CaptchaUnavailableError("CAPTCHA is enabled but no Turnstile secret key is available")
    return secret


def _signing_key() -> bytes:
    # Derived from the Turnstile secret, so there is one secret to manage and
    # rotating it also invalidates every outstanding pass.
    return hmac.new(_secret().encode(), b"ciroh-chat-human-pass", hashlib.sha256).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue_pass(email: str, now: Optional[float] = None) -> tuple[str, int]:
    """Signed pass for `email`; returns (pass, expires_at unix seconds)."""
    expires_at = int((now if now is not None else time.time()) + pass_ttl_seconds())
    payload = _b64(json.dumps({"v": _PASS_VERSION, "e": email, "x": expires_at}, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}", expires_at


def check_pass(human_pass: Optional[str], email: str, now: Optional[float] = None) -> bool:
    """True if `human_pass` was issued by this API for `email` and hasn't expired."""
    if not human_pass or human_pass.count(".") != 1:
        return False
    payload, signature = human_pass.split(".")
    expected = _b64(hmac.new(_signing_key(), payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        data = json.loads(_unb64(payload))
    except (ValueError, json.JSONDecodeError):
        return False
    if data.get("v") != _PASS_VERSION or data.get("e") != email:
        return False
    return int(data.get("x", 0)) > (now if now is not None else time.time())


def _allowed_hostnames() -> set[str]:
    raw = os.getenv("TURNSTILE_ALLOWED_HOSTNAMES", "")
    return {h.strip().lower() for h in raw.split(",") if h.strip()}


def _siteverify(token: str, remote_ip: Optional[str]) -> dict:
    form = {"secret": _secret(), "response": token}
    if remote_ip:
        form["remoteip"] = remote_ip
    request = urllib.request.Request(
        SITEVERIFY_URL,
        data=urllib.parse.urlencode(form).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise CaptchaUnavailableError(f"Turnstile siteverify failed: {exc}") from exc


def verify_token(token: str, remote_ip: Optional[str] = None) -> tuple[bool, list[str]]:
    """Check a Turnstile widget token with Cloudflare. Returns (ok, error codes)."""
    result = _siteverify(token, remote_ip)
    if not result.get("success"):
        return False, list(result.get("error-codes") or ["verification-failed"])
    allowed = _allowed_hostnames()
    if allowed and str(result.get("hostname", "")).lower() not in allowed:
        return False, ["hostname-mismatch"]
    return True, []
