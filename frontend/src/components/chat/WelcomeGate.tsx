// WelcomeGate.tsx
//
// First screen of the chat: the privacy notice plus the email the visitor
// must provide before asking questions (the API limits questions per email
// per day), and, when the API has it switched on, the CAPTCHA
// (docs/CAPTCHA.md).

import { FormEvent, useState } from 'react';
import { Bot, ArrowRight, Loader2 } from 'lucide-react';
import { PrivacyNotice } from './PrivacyNotice';
import { TurnstileWidget } from './TurnstileWidget';
import { DAILY_QUESTION_LIMIT } from './data';
import { normalizeEmail } from '../../services/user';
import { CAPTCHA_DISABLED, CaptchaConfig, HumanPass, verifyHuman } from '../../services/captcha';

interface WelcomeGateProps {
  isDarkMode: boolean;
  initialEmail?: string | null;
  captcha?: CaptchaConfig;
  /** Why the visitor is here again (e.g. their verification expired). */
  notice?: string | null;
  onSubmit: (email: string, humanPass: HumanPass | null) => void;
}

export function WelcomeGate({
  isDarkMode,
  initialEmail,
  captcha = CAPTCHA_DISABLED,
  notice,
  onSubmit,
}: WelcomeGateProps) {
  const [value, setValue] = useState(initialEmail ?? '');
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [widgetKey, setWidgetKey] = useState(0);
  const [verifying, setVerifying] = useState(false);

  const captchaOn = captcha.enabled;
  const canSubmit = !verifying && (!captchaOn || !!captchaToken);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const email = normalizeEmail(value);
    if (!email) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!captchaOn) {
      onSubmit(email, null);
      return;
    }
    if (!captchaToken) {
      setCaptchaError('Please complete the verification check.');
      return;
    }
    setVerifying(true);
    setCaptchaError(null);
    try {
      const pass = await verifyHuman(captchaToken, email);
      onSubmit(email, pass);
    } catch (err) {
      setCaptchaError(err instanceof Error ? err.message : 'Verification failed. Please try again.');
      // Turnstile tokens are single-use: get a fresh one for the retry.
      setCaptchaToken(null);
      setWidgetKey(k => k + 1);
    } finally {
      setVerifying(false);
    }
  };

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2 pt-1">
        <div
          className={`mx-auto h-11 w-11 rounded-full flex items-center justify-center ${
            isDarkMode ? 'bg-gray-700' : 'bg-primary-500/15'
          }`}
        >
          <Bot className={`h-6 w-6 ${isDarkMode ? 'text-gray-200' : 'text-primary-600'}`} />
        </div>
        <h2 className={`text-base font-semibold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
          Welcome to CIROH AI
        </h2>
        <p className={`text-sm ${muted}`}>
          Ask about CIROH tools, data, services and research. Answers come from
          CIROH documentation, with sources.
        </p>
      </div>

      {notice && (
        <div
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm ${
            isDarkMode
              ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}
        >
          {notice}
        </div>
      )}

      <section
        className={`rounded-xl border p-4 ${
          isDarkMode ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-gray-50'
        }`}
        aria-labelledby="privacy-heading"
      >
        <h3
          id="privacy-heading"
          className={`text-xs font-semibold uppercase tracking-wide mb-3 ${muted}`}
        >
          Your privacy
        </h3>
        <PrivacyNotice isDarkMode={isDarkMode} />
      </section>

      <form onSubmit={handleSubmit} className="space-y-2" noValidate>
        <label
          htmlFor="ciroh-chat-email"
          className={`block text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}
        >
          Your email address
        </label>
        <input
          id="ciroh-chat-email"
          type="email"
          autoComplete="email"
          value={value}
          onChange={e => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder="name@university.edu"
          aria-invalid={error ? true : undefined}
          aria-describedby="ciroh-chat-email-help"
          className={`w-full px-4 py-2 border rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent ${
            isDarkMode
              ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
              : 'bg-white border-gray-300'
          }`}
        />
        <p
          id="ciroh-chat-email-help"
          className={`text-xs ${error ? 'text-red-500' : muted}`}
          role={error ? 'alert' : undefined}
        >
          {error ?? `Used only to apply the limit of ${DAILY_QUESTION_LIMIT} questions per day.`}
        </p>
        {captchaOn && (
          <div className="pt-1 space-y-1" aria-label="Verification check">
            {captcha.site_key ? (
              <TurnstileWidget
                siteKey={captcha.site_key}
                isDarkMode={isDarkMode}
                resetKey={widgetKey}
                onToken={token => {
                  setCaptchaToken(token);
                  if (token) setCaptchaError(null);
                }}
              />
            ) : (
              <p className={`text-xs text-center ${muted}`}>Loading the verification check...</p>
            )}
            {captchaError && (
              <p className="text-xs text-red-500 text-center" role="alert">
                {captchaError}
              </p>
            )}
          </div>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="w-full mt-1 flex items-center justify-center gap-2 rounded-full bg-primary-600 hover:bg-primary-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 transition-colors"
        >
          {verifying ? (
            <>
              Verifying
              <Loader2 className="h-4 w-4 animate-spin" />
            </>
          ) : (
            <>
              Agree and start chatting
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
