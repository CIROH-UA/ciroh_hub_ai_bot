// Human verification (CAPTCHA) with Cloudflare Turnstile.
//
// The backend decides whether it is on (GET /captcha/config). When it is,
// the welcome screen shows the Turnstile widget; its one-time token is
// exchanged at POST /captcha/verify for a signed "human pass" bound to the
// visitor's email, which every question then carries as `human_pass`.
// See docs/CAPTCHA.md.

import { API_CONFIG, getApiUrl } from '../config/api';

export interface CaptchaConfig {
  enabled: boolean;
  provider: 'turnstile' | null;
  site_key: string | null;
}

export interface HumanPass {
  pass: string;
  email: string;
  /** ISO timestamp from the server. */
  expiresAt: string;
}

export const CAPTCHA_DISABLED: CaptchaConfig = { enabled: false, provider: null, site_key: null };

const PASS_KEY = 'ciroh_chat_human_pass';
const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Thrown when the API refuses a question because the human pass is
 * missing, expired or for another email: the visitor must verify again. */
export class CaptchaRequiredError extends Error {
  constructor(message = 'Please confirm you are human to keep chatting.') {
    super(message);
    this.name = 'CaptchaRequiredError';
  }
}

/** Reads the `{detail: {code, message}}` body FastAPI sends with a 403. */
export async function captchaErrorFrom(response: Response): Promise<CaptchaRequiredError | null> {
  if (response.status !== 403) return null;
  try {
    const body = await response.clone().json();
    if (body?.detail?.code === 'captcha_required') {
      return new CaptchaRequiredError(body.detail.message);
    }
  } catch {
    // Not JSON (e.g. a WAF block page): not a CAPTCHA refusal.
  }
  return null;
}

/** Whether the chat must show the CAPTCHA. If the config can't be read the
 * chat starts without it; the API still refuses unverified questions, and
 * that refusal brings the visitor back to verify. */
export async function fetchCaptchaConfig(): Promise<CaptchaConfig> {
  try {
    const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.CAPTCHA_CONFIG));
    if (!response.ok) return CAPTCHA_DISABLED;
    const config = (await response.json()) as CaptchaConfig;
    return config?.enabled && config.site_key ? config : CAPTCHA_DISABLED;
  } catch {
    return CAPTCHA_DISABLED;
  }
}

/** Exchanges a Turnstile widget token for a human pass. */
export async function verifyHuman(token: string, email: string): Promise<HumanPass> {
  let response: Response;
  try {
    response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.CAPTCHA_VERIFY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email }),
    });
  } catch {
    throw new Error('Unable to reach the server. Please check your connection and try again.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.human_pass) {
    throw new Error(body?.detail?.message || 'Verification failed. Please try again.');
  }
  return { pass: body.human_pass, email, expiresAt: body.expires_at };
}

export function isPassValid(pass: HumanPass | null, email: string | null, now = Date.now()): boolean {
  if (!pass || !email || pass.email !== email) return false;
  // A minute of slack so a pass doesn't expire between check and request.
  return Date.parse(pass.expiresAt) - 60_000 > now;
}

export function getHumanPass(): HumanPass | null {
  try {
    const saved = JSON.parse(localStorage.getItem(PASS_KEY) || 'null');
    return saved && typeof saved.pass === 'string' ? (saved as HumanPass) : null;
  } catch {
    return null;
  }
}

export function setHumanPass(pass: HumanPass): void {
  try {
    localStorage.setItem(PASS_KEY, JSON.stringify(pass));
  } catch {
    // Private mode: the pass lasts for this page view only.
  }
}

export function clearHumanPass(): void {
  try {
    localStorage.removeItem(PASS_KEY);
  } catch {
    // Ignore.
  }
}

// --- Turnstile widget script -------------------------------------------------

export interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  action?: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
  'timeout-callback'?: () => void;
}

export interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** Loads Cloudflare's widget script once, on first use. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
    script.onerror = () => {
      scriptPromise = null; // allow a retry
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}
