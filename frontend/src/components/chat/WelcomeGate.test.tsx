import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WelcomeGate } from './WelcomeGate';
import type { TurnstileRenderOptions } from '../../services/captcha';

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

// Fake Turnstile: records the widget's callbacks so tests can "solve" it.
let widget: TurnstileRenderOptions | null = null;
const turnstile = {
  render: vi.fn((_el: HTMLElement, options: TurnstileRenderOptions) => {
    widget = options;
    return 'widget-1';
  }),
  reset: vi.fn(),
  remove: vi.fn(),
};

const captcha = { enabled: true, provider: 'turnstile' as const, site_key: 'site-key' };

function typeEmail(email: string) {
  fireEvent.change(screen.getByLabelText('Your email address'), { target: { value: email } });
}

beforeEach(() => {
  fetchMock.mockReset();
  turnstile.render.mockClear();
  widget = null;
  window.turnstile = turnstile;
});

describe('WelcomeGate', () => {
  it('without CAPTCHA submits the email straight away', () => {
    const onSubmit = vi.fn();
    render(<WelcomeGate isDarkMode={false} onSubmit={onSubmit} />);
    typeEmail('Jane@UA.edu');
    fireEvent.click(screen.getByRole('button', { name: /agree and start chatting/i }));
    expect(onSubmit).toHaveBeenCalledWith('jane@ua.edu', null);
    expect(screen.queryByTestId('turnstile-widget')).toBeNull();
  });

  it('with CAPTCHA waits for the widget, then exchanges its token for a pass', async () => {
    const onSubmit = vi.fn();
    render(<WelcomeGate isDarkMode={false} captcha={captcha} onSubmit={onSubmit} />);
    typeEmail('jane@ua.edu');

    const button = screen.getByRole('button', { name: /agree and start chatting/i });
    expect(button).toBeDisabled();
    await waitFor(() => expect(turnstile.render).toHaveBeenCalled());
    expect(widget?.sitekey).toBe('site-key');

    act(() => widget!.callback!('widget-token'));
    expect(button).not.toBeDisabled();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ human_pass: 'p.s', expires_at: '2030-01-01T00:00:00Z' }), { status: 200 })
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith('jane@ua.edu', {
        pass: 'p.s',
        email: 'jane@ua.edu',
        expiresAt: '2030-01-01T00:00:00Z',
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: 'widget-token', email: 'jane@ua.edu' });
  });

  it('shows the error and a fresh widget when verification fails', async () => {
    const onSubmit = vi.fn();
    render(<WelcomeGate isDarkMode={false} captcha={captcha} onSubmit={onSubmit} />);
    typeEmail('jane@ua.edu');
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(1));
    act(() => widget!.callback!('used-token'));

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: { code: 'captcha_failed', message: 'Verification failed. Please try again.' } }), {
        status: 403,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /agree and start chatting/i }));
    expect(await screen.findByText('Verification failed. Please try again.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(turnstile.render).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: /agree and start chatting/i })).toBeDisabled();
  });

  it('shows why the visitor has to verify again, with their email kept', () => {
    render(
      <WelcomeGate
        isDarkMode={false}
        captcha={captcha}
        initialEmail="jane@ua.edu"
        notice="Please confirm you are human to keep chatting."
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByText('Please confirm you are human to keep chatting.')).toBeInTheDocument();
    expect(screen.getByLabelText('Your email address')).toHaveValue('jane@ua.edu');
  });
});
