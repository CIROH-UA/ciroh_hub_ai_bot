"""Human verification: /captcha/config, /captcha/verify and the human pass
that /ask and /ask/stream require once CAPTCHA is enabled (Cloudflare's
siteverify API faked)."""

from __future__ import annotations

import json

import pytest

import captcha

QUESTION = "How do I install NGIAB?"
EMAIL = "test@ua.edu"


@pytest.fixture
def siteverify(monkeypatch):
    """Turn CAPTCHA on with a fake Turnstile; state["result"] is what
    siteverify answers and state["calls"] records what it was sent."""
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "test-secret")
    monkeypatch.setenv("TURNSTILE_SITE_KEY", "test-site-key")
    monkeypatch.delenv("TURNSTILE_ALLOWED_HOSTNAMES", raising=False)
    state = {"result": {"success": True, "hostname": "chat.ciroh.org"}, "calls": []}

    def fake(token, remote_ip):
        state["calls"].append({"token": token, "remote_ip": remote_ip})
        return state["result"]

    monkeypatch.setattr(captcha, "_siteverify", fake)
    return state


def get_pass(client, email=EMAIL):
    r = client.post("/captcha/verify", json={"token": "widget-token", "email": email})
    assert r.status_code == 200, r.text
    return r.json()["human_pass"]


def test_disabled_by_default(client):
    assert client.get("/captcha/config").json() == {"enabled": False, "provider": None, "site_key": None}
    r = client.post("/ask/stream", json={"text": QUESTION, "email": EMAIL})
    assert r.status_code == 200


def test_config_exposes_only_the_public_site_key(client, siteverify):
    assert client.get("/captcha/config").json() == {
        "enabled": True,
        "provider": "turnstile",
        "site_key": "test-site-key",
    }


def test_questions_without_a_pass_are_refused(client, siteverify, usage_db):
    for path in ("/ask", "/ask/stream"):
        r = client.post(path, json={"text": QUESTION, "email": EMAIL})
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "captcha_required"
    assert usage_db.used == {}  # refused before counting against the limit


def test_verified_pass_allows_questions(client, siteverify):
    human_pass = get_pass(client)
    r = client.post("/ask/stream", json={"text": QUESTION, "email": EMAIL, "human_pass": human_pass})
    assert r.status_code == 200
    events = [json.loads(line) for line in r.text.splitlines()]
    assert events[-1]["type"] == "done"
    r = client.post("/ask", json={"text": QUESTION, "email": EMAIL, "human_pass": human_pass})
    assert r.status_code == 200
    assert siteverify["calls"] == [{"token": "widget-token", "remote_ip": "testclient"}]


def test_pass_is_bound_to_the_email(client, siteverify):
    human_pass = get_pass(client, email="Jane@UA.edu")
    ok = client.post("/ask", json={"text": QUESTION, "email": "jane@ua.edu", "human_pass": human_pass})
    assert ok.status_code == 200
    other = client.post("/ask", json={"text": QUESTION, "email": "someone@ua.edu", "human_pass": human_pass})
    assert other.status_code == 403


def test_forged_or_tampered_pass_is_refused(client, siteverify):
    human_pass = get_pass(client)
    payload, signature = human_pass.split(".")
    for bad in ["garbage", f"{payload}.{signature[:-2]}xx", f"{payload}x.{signature}", "a.b.c"]:
        r = client.post("/ask", json={"text": QUESTION, "email": EMAIL, "human_pass": bad})
        assert r.status_code == 403, bad


def test_pass_expires(siteverify):
    human_pass, expires_at = captcha.issue_pass(EMAIL, now=1_000)
    assert expires_at == 1_000 + 24 * 3600
    assert captcha.check_pass(human_pass, EMAIL, now=expires_at - 1)
    assert not captcha.check_pass(human_pass, EMAIL, now=expires_at)


def test_rotating_the_secret_invalidates_passes(siteverify, monkeypatch):
    human_pass, _ = captcha.issue_pass(EMAIL)
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "rotated-secret")
    assert not captcha.check_pass(human_pass, EMAIL)


def test_failed_challenge_gets_no_pass(client, siteverify):
    siteverify["result"] = {"success": False, "error-codes": ["invalid-input-response"]}
    r = client.post("/captcha/verify", json={"token": "bad", "email": EMAIL})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "captcha_failed"
    assert r.json()["detail"]["errors"] == ["invalid-input-response"]


def test_hostname_allowlist(client, siteverify, monkeypatch):
    monkeypatch.setenv("TURNSTILE_ALLOWED_HOSTNAMES", "hub.ciroh.org")
    r = client.post("/captcha/verify", json={"token": "widget-token", "email": EMAIL})
    assert r.status_code == 403
    assert r.json()["detail"]["errors"] == ["hostname-mismatch"]
    monkeypatch.setenv("TURNSTILE_ALLOWED_HOSTNAMES", "hub.ciroh.org, Chat.CIROH.org")
    assert get_pass(client)


def test_verify_needs_a_valid_email(client, siteverify):
    r = client.post("/captcha/verify", json={"token": "widget-token", "email": "nope"})
    assert r.status_code == 400
    assert siteverify["calls"] == []


def test_siteverify_outage_fails_closed(client, siteverify, monkeypatch):
    def down(token, remote_ip):
        raise captcha.CaptchaUnavailableError("timed out")

    monkeypatch.setattr(captcha, "_siteverify", down)
    r = client.post("/captcha/verify", json={"token": "widget-token", "email": EMAIL})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "captcha_unavailable"


def test_missing_secret_fails_closed(client, monkeypatch):
    monkeypatch.delenv("TURNSTILE_SECRET_KEY", raising=False)
    monkeypatch.setenv("TURNSTILE_SECRET_ARN", "arn:aws:secretsmanager:us-east-1:123:secret:x")

    def unreadable(arn):
        raise captcha.CaptchaUnavailableError("AccessDenied")

    monkeypatch.setattr(captcha, "_secret_from_secrets_manager", unreadable)
    r = client.post("/ask", json={"text": QUESTION, "email": EMAIL, "human_pass": "a.b"})
    assert r.status_code == 503


def test_secrets_manager_secret_formats(monkeypatch):
    class FakeSecrets:
        def __init__(self, value):
            self.value = value

        def get_secret_value(self, SecretId):  # noqa: N803 - boto3's name
            return {"SecretString": self.value}

    import boto3

    for stored, expected in [("0xplain", "0xplain"), ('{"secret_key": "0xjson"}', "0xjson")]:
        captcha._secret_from_secrets_manager.cache_clear()
        monkeypatch.setattr(boto3, "client", lambda *a, value=stored, **k: FakeSecrets(value))
        assert captcha._secret_from_secrets_manager("arn") == expected
    captcha._secret_from_secrets_manager.cache_clear()
