# CAPTCHA (Human Verification)

The chat asks visitors to pass a CAPTCHA before their first question, so
bots and scripts can't run up Bedrock costs or flood the API. It uses
[Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/).

CAPTCHA is **off until you configure it**. Local development, the tests and
existing deployments behave exactly as before until both Turnstile keys are
set.

## Why Turnstile

| | Cloudflare Turnstile (used) | Google reCAPTCHA | AWS WAF CAPTCHA |
|---|---|---|---|
| Cost | Free, unlimited | Free up to 10k/month, then paid | $0.40 per 1,000 challenges |
| What visitors see | Usually a checkbox that ticks itself, no puzzles | Image puzzles fairly often | Image puzzles |
| Privacy | No ad tracking, no cookies used for ads | Google tracking cookies | AWS-hosted |
| Hosting needed | None (the site doesn't have to be on Cloudflare) | None | Already on CloudFront |
| Works with the streaming `fetch` POSTs | Yes (token in the request body) | Yes | Awkward: needs the WAF JS SDK and token cookies |

Turnstile fits the privacy notice the chat already shows (no ad tracking),
costs nothing, and needs no change to how CloudFront signs `/ask/stream`.

## How it works

```
Browser                         API (Lambda)                     Cloudflare
───────                         ────────────                     ──────────
GET /captcha/config  ─────────▶ {enabled, site_key}
Welcome screen: email + Turnstile widget
widget solved ──────────────────────────────────────────────────▶ (challenge)
              ◀────────────────────────────────────────────────── one-time token
POST /captcha/verify {token, email} ─▶ siteverify(token) ───────▶ success?
              ◀──────────────── signed human pass (24h, bound to the email)
POST /ask/stream {text, email, human_pass} ─▶ check signature (no network call)
```

1. When the chat opens, the frontend calls `GET /captcha/config` to see
   whether the CAPTCHA is on and to get the widget's public site key.
2. The welcome screen (`WelcomeGate.tsx`) shows the Turnstile widget under
   the email field. **Agree and start chatting** stays disabled until the
   widget is solved.
3. On submit, the browser sends the Turnstile token and the email to
   `POST /captcha/verify`. The API checks the token with Cloudflare's
   `siteverify` API. If it passes, the API returns a **human pass**: an
   HMAC-signed token holding the email and an expiry time.
4. Every `/ask` and `/ask/stream` request carries the pass as `human_pass`.
   The API checks the signature, the email and the expiry before it does
   any Bedrock or database work. That check is a local HMAC comparison,
   so it adds no latency and needs no network call or database.

Why a pass instead of a CAPTCHA per question: Turnstile tokens can be used
only once and expire after 5 minutes. Asking for a new one every question
would be slow and annoying. One check per email per day is enough to stop
automated abuse. The daily question limit and WAF handle the rest.

### What the visitor sees

- **First visit:** privacy notice, email field, Turnstile checkbox (usually
  ticks itself), then the chat.
- **Returning within 24h:** straight to the chat (the pass is kept in
  `localStorage` as `ciroh_chat_human_pass`).
- **Pass expired, or the secret was rotated:** the next question gets a
  `403 captcha_required`. The chat returns to the welcome screen with the
  email already filled in and the notice "Please confirm you are human to
  keep chatting." The unanswered question goes back into the input box.
- **Changing email:** clears the pass. A pass only works for the email it
  was issued to.

### The human pass

```
base64url({"v":1,"e":"jane@ua.edu","x":1763337600}) . base64url(HMAC-SHA256)
```

- Signed with a key derived from the Turnstile **secret key**
  (`HMAC(secret, "ciroh-chat-human-pass")`), so there is only one secret to
  manage. Rotating the Turnstile secret invalidates every outstanding pass.
- Bound to the normalized (trimmed, lower-cased) email, so a pass can't be
  shared across addresses to get around the daily limit.
- Valid for `CAPTCHA_PASS_TTL_HOURS` (default 24).
- Not stored server-side. Nothing new is written to the database.

## Setup

### 1. Create a Turnstile widget (Cloudflare dashboard)

1. Sign in to (or create) a free Cloudflare account at
   <https://dash.cloudflare.com>. The chatbot's domain does **not** need to
   be on Cloudflare.
2. Go to **Turnstile → Add widget**.
3. **Hostnames:** add every hostname the chat is served from, e.g. the
   CloudFront domain (`dxxxxxxxxxxxx.cloudfront.net`), the custom domain if
   there is one, and `localhost` for local testing.
4. **Widget mode:** *Managed* (recommended: Cloudflare decides whether to
   show an interactive check).
5. Copy the **Site Key** (public) and the **Secret Key** (private).

### 2. Store the secret key in AWS Secrets Manager

The secret key never goes into the code, `cdk.json` or the Lambda
environment. Only the ARN of the secret does.

```bash
aws secretsmanager create-secret --region us-east-1 --name ciroh-docuhub/turnstile --secret-string "0x4AAAA...your-secret-key"
```

Copy the `ARN` it prints. A JSON secret such as
`{"secret_key": "0x4AAAA..."}` also works.

### 3. Turn it on in `infra/cdk.json`

```json
"turnstile_site_key": "0x4AAAAAAA...your-site-key",
"turnstile_secret_arn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:ciroh-docuhub/turnstile-AbCdEf",
"turnstile_allowed_hostnames": "dxxxxxxxxxxxx.cloudfront.net",
"captcha_pass_ttl_hours": 24
```

Or pass the same keys with `-c` on the command line
(`cdk deploy CirohStack -c turnstile_site_key=... -c turnstile_secret_arn=...`).

Then deploy as usual: push to `aws-bedrock-migration` (CI) or run
`python scripts/deploy_frontend.py`. CAPTCHA turns on only when **both**
`turnstile_site_key` and `turnstile_secret_arn` are set. If only one is
set, `cdk synth` prints a warning and CAPTCHA stays off.

The deploy:

- passes `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_ARN` and the optional
  settings to both Lambda functions (`backend_stack.py`),
- gives both functions `secretsmanager:GetSecretValue` on that one secret
  only,
- routes `/captcha/*` through CloudFront to the API (`frontend_stack.py`).

No frontend rebuild setting is needed. The frontend reads the site key from
`/captcha/config` at runtime.

### 4. Check it

```bash
curl https://dxxxxxxxxxxxx.cloudfront.net/captcha/config
```

You should see `{"enabled":true,"provider":"turnstile","site_key":"0x4AAAA..."}`.
Then open the chat in a private window: the Turnstile widget should appear
under the email field.

## Configuration reference

| Setting | CDK context key | Lambda env var | Default | Notes |
|---|---|---|---|---|
| Widget site key (public) | `turnstile_site_key` | `TURNSTILE_SITE_KEY` | empty (off) | Sent to browsers by `/captcha/config` |
| Secret key location | `turnstile_secret_arn` | `TURNSTILE_SECRET_ARN` | empty (off) | Secrets Manager ARN; read once per Lambda container |
| Secret key (local dev only) | — | `TURNSTILE_SECRET_KEY` | empty | Used instead of the ARN when set; put it in `.env` |
| Allowed hostnames | `turnstile_allowed_hostnames` | `TURNSTILE_ALLOWED_HOSTNAMES` | empty (any) | Comma-separated; rejects tokens solved on other sites |
| Pass lifetime | `captcha_pass_ttl_hours` | `CAPTCHA_PASS_TTL_HOURS` | `24` | Hours before the visitor has to verify again |

CAPTCHA is on when `TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_ARN` is set
in the API's environment.

## API reference

### `GET /captcha/config`

```json
{"enabled": true, "provider": "turnstile", "site_key": "0x4AAAA..."}
```

With CAPTCHA off: `{"enabled": false, "provider": null, "site_key": null}`.

### `POST /captcha/verify`

Request: `{"token": "<Turnstile widget token>", "email": "jane@ua.edu"}`

| Status | Body | When |
|---|---|---|
| 200 | `{"enabled": true, "human_pass": "...", "expires_at": "2026-11-17T15:00:00+00:00"}` | Token accepted |
| 200 | `{"enabled": false, "human_pass": null, "expires_at": null}` | CAPTCHA is off |
| 400 | `{"detail": "A valid email address is required."}` | Bad email |
| 403 | `{"detail": {"code": "captcha_failed", "message": "...", "errors": ["invalid-input-response"]}}` | Cloudflare rejected the token (or `hostname-mismatch`) |
| 503 | `{"detail": {"code": "captcha_unavailable", "message": "..."}}` | Secret unreadable or Cloudflare unreachable |

### `/ask` and `/ask/stream`

These take one new optional body field, `human_pass`. With CAPTCHA on, a
missing, expired, tampered or other-email pass gets:

```json
HTTP 403
{"detail": {"code": "captcha_required", "message": "Please confirm you are human to keep chatting."}}
```

The check runs after email validation and before the daily limit, so a
refused request doesn't count against the visitor's questions.

## Failure behavior

- **Fails closed.** Once configured, if the secret can't be read
  (permissions, wrong ARN) or Cloudflare's `siteverify` is down, the API
  returns `503 captcha_unavailable`. It never quietly lets requests
  through. Visitors who already have a valid pass are only affected if the
  secret itself can't be read.
- **Widget script blocked** (ad blocker, strict network): the welcome screen
  says the check couldn't load and asks the visitor to allow
  `challenges.cloudflare.com`.
- **`/captcha/config` unreachable:** the chat starts without the widget. If
  the API does enforce CAPTCHA, the first question gets `captcha_required`
  and the visitor is sent back to verify.

## Local development

CAPTCHA stays off unless you set the keys. To try it locally, use
Cloudflare's [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
in the repo-root `.env`:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

These always pass. To test failure handling, use site key
`2x00000000000000000000AB` (always blocks) or secret key
`2x0000000000000000000000000000000AA` (always fails verification).

Then run the API and frontend as usual (see the README). The widget
appears on the welcome screen.

## Tests

- `backend/tests/test_captcha.py`: config, verify, pass checks on both
  question endpoints, email binding, tampering, expiry, secret rotation,
  hostname allowlist, fail-closed on outages, Secrets Manager formats.
  Cloudflare is faked, so the tests make no network calls.
- `frontend/src/services/captcha.test.ts`: config, verify, pass validity,
  and how `ChatAPI` turns a `captcha_required` 403 into
  `CaptchaRequiredError` (and skips the `/ask` fallback for it).
- `frontend/src/components/chat/WelcomeGate.test.tsx`: the widget flow
  with a fake Turnstile, error handling and the "verify again" notice.

Run them with `pytest backend/tests` and `cd frontend && npx vitest run`
(CI runs both before every deploy).

### Post-deploy smoke test

`scripts/smoke_test.py` checks `/captcha/config`. If CAPTCHA is on, it
also checks that a question without a pass gets `403`. It can't solve a
real Turnstile challenge, so for the question checks it needs the secret
key in its environment to sign a pass itself:

```bash
TURNSTILE_SECRET_KEY=0x4AAAA... python scripts/smoke_test.py
```

Without it, the question checks are skipped with a warning. To keep them in
CI, add `TURNSTILE_SECRET_KEY` as a GitHub Actions secret and pass it to
the "Smoke test the live site" step in `.github/workflows/deploy.yml`.

## Files

| File | What it does |
|---|---|
| `backend/rag/captcha.py` | Turnstile `siteverify` call, pass signing and checking, secret loading |
| `backend/rag/main.py` | `/captcha/config`, `/captcha/verify`, and the `human_pass` check on `/ask` and `/ask/stream` |
| `frontend/src/services/captcha.ts` | Config/verify calls, pass storage, Turnstile script loader |
| `frontend/src/components/chat/TurnstileWidget.tsx` | Renders the widget (follows dark mode) |
| `frontend/src/components/chat/WelcomeGate.tsx` | Shows the widget and exchanges its token for a pass |
| `frontend/src/components/chat/useChat.ts` | Sends the pass and returns to the gate on `captcha_required` |
| `infra/app.py`, `infra/stacks/backend_stack.py`, `infra/stacks/frontend_stack.py` | CDK context, Lambda env and IAM, CloudFront `/captcha/*` route |

## Notes and limits

- **Rotating the secret:** update the Secrets Manager value (and the key
  in the Turnstile dashboard). Running Lambda containers cache the secret,
  so redeploy (or wait for containers to recycle) to pick up the new one.
  All existing passes stop working and visitors verify again once.
- **`/telemetry` is not gated.** It costs almost nothing and is already
  rate limited by WAF.
- **The WAF rate limit** still covers `/ask*` per IP. CAPTCHA adds to it;
  it doesn't replace it. Someone who solves one CAPTCHA per email still
  hits the daily question limit and the WAF limit.
- **Privacy:** Turnstile gets the visitor's IP address and browser signals
  (the same as loading any third-party script) but **not** their email or
  questions. If the privacy notice (`PrivacyNotice.tsx`) needs to list
  third parties, add Cloudflare Turnstile.
