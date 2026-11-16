import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CAPTCHA_DISABLED,
  CaptchaRequiredError,
  captchaErrorFrom,
  fetchCaptchaConfig,
  isPassValid,
  verifyHuman,
} from './captcha';
import { ChatAPI } from './api';

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => fetchMock.mockReset());

describe('fetchCaptchaConfig', () => {
  it('returns the API config when enabled with a site key', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { enabled: true, provider: 'turnstile', site_key: 'k' }));
    expect(await fetchCaptchaConfig()).toEqual({ enabled: true, provider: 'turnstile', site_key: 'k' });
  });

  it('treats errors, old backends and a missing site key as disabled', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));
    expect(await fetchCaptchaConfig()).toEqual(CAPTCHA_DISABLED);
    fetchMock.mockResolvedValueOnce(json(404, { detail: 'Not Found' }));
    expect(await fetchCaptchaConfig()).toEqual(CAPTCHA_DISABLED);
    fetchMock.mockResolvedValueOnce(json(200, { enabled: true, provider: 'turnstile', site_key: null }));
    expect(await fetchCaptchaConfig()).toEqual(CAPTCHA_DISABLED);
  });
});

describe('verifyHuman', () => {
  it('exchanges the widget token for a pass bound to the email', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { human_pass: 'p.s', expires_at: '2030-01-01T00:00:00+00:00' }));
    const pass = await verifyHuman('tok', 'a@ua.edu');
    expect(pass).toEqual({ pass: 'p.s', email: 'a@ua.edu', expiresAt: '2030-01-01T00:00:00+00:00' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: 'tok', email: 'a@ua.edu' });
  });

  it("shows the server's message when verification fails", async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, { detail: { code: 'captcha_failed', message: 'Verification failed. Please try again.' } })
    );
    await expect(verifyHuman('bad', 'a@ua.edu')).rejects.toThrow('Verification failed. Please try again.');
  });
});

describe('isPassValid', () => {
  const now = Date.parse('2030-01-01T00:00:00Z');
  const pass = { pass: 'p.s', email: 'a@ua.edu', expiresAt: '2030-01-01T12:00:00Z' };

  it('accepts an unexpired pass for the same email', () => {
    expect(isPassValid(pass, 'a@ua.edu', now)).toBe(true);
  });

  it('rejects another email, an expired pass or no pass', () => {
    expect(isPassValid(pass, 'b@ua.edu', now)).toBe(false);
    expect(isPassValid(pass, 'a@ua.edu', Date.parse('2030-01-01T12:00:00Z'))).toBe(false);
    expect(isPassValid(null, 'a@ua.edu', now)).toBe(false);
  });
});

describe('CAPTCHA refusals from the chat API', () => {
  const refusal = () =>
    json(403, { detail: { code: 'captcha_required', message: 'Please confirm you are human to keep chatting.' } });

  it('recognises only the captcha_required 403', async () => {
    expect(await captchaErrorFrom(refusal())).toBeInstanceOf(CaptchaRequiredError);
    expect(await captchaErrorFrom(new Response('<html>blocked</html>', { status: 403 }))).toBeNull();
    expect(await captchaErrorFrom(json(500, {}))).toBeNull();
  });

  it('streamQuestion throws CaptchaRequiredError instead of falling back', async () => {
    fetchMock.mockResolvedValueOnce(refusal());
    await expect(
      new ChatAPI().streamQuestion({ text: 'q', email: 'a@ua.edu', human_pass: null })
    ).rejects.toBeInstanceOf(CaptchaRequiredError);
  });

  it('sendQuestion throws CaptchaRequiredError and sends the pass', async () => {
    fetchMock.mockResolvedValueOnce(refusal());
    await expect(
      new ChatAPI().sendQuestion({ text: 'q', email: 'a@ua.edu', human_pass: 'p.s' })
    ).rejects.toBeInstanceOf(CaptchaRequiredError);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).human_pass).toBe('p.s');
  });
});
