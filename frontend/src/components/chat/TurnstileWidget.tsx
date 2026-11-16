// TurnstileWidget.tsx
//
// Cloudflare Turnstile CAPTCHA. Most visitors see a checkbox that ticks
// itself; a suspicious browser gets an interactive challenge. Calls
// onToken with a one-time token when solved, and onToken(null) when that
// token expires or the widget fails.

import { useEffect, useRef, useState } from 'react';
import { loadTurnstile } from '../../services/captcha';

interface TurnstileWidgetProps {
  siteKey: string;
  isDarkMode: boolean;
  onToken: (token: string | null) => void;
  /** Change this to get a fresh widget (tokens are single-use). */
  resetKey?: number;
}

export function TurnstileWidget({ siteKey, isDarkMode, onToken, resetKey = 0 }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;
    setLoadError(false);

    loadTurnstile()
      .then(turnstile => {
        if (cancelled || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: isDarkMode ? 'dark' : 'light',
          action: 'chat_start',
          callback: token => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'timeout-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      onTokenRef.current(null);
    };
  }, [siteKey, isDarkMode, resetKey]);

  return (
    <div>
      <div ref={containerRef} className="flex justify-center min-h-[65px]" data-testid="turnstile-widget" />
      {loadError && (
        <p className="text-xs text-red-500 text-center" role="alert">
          The verification check could not load. Please disable any content blocker for
          challenges.cloudflare.com and reload the page.
        </p>
      )}
    </div>
  );
}
