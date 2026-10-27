'use client';
// P5.1: sign in with a mobile number (a code on WhatsApp, or by SMS) or an email address (a code by
// email; agencies mostly). Two steps on one page: where to send the code, then the code.
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Me } from '../../lib/api';
import {
  backTo,
  looksLikeCode,
  looksLikeEmail,
  looksLikeMobile,
  timeLeft,
  type Way,
} from '../../lib/sign-in';

type Channel = 'whatsapp' | 'sms' | 'email';

interface Sent {
  readonly address: string;
  readonly shown: string;
  readonly channel: Channel;
  readonly expiresAt: number;
}

const message = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Could not reach the server. Try again.';

export default function SignIn() {
  const router = useRouter();
  const [way, setWay] = useState<Way>('phone');
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<Sent>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);

  // Already signed in: straight in.
  useEffect(() => {
    api<Me>('/me')
      .then(() => router.replace(backTo(new URLSearchParams(window.location.search).get('next'))))
      .catch(() => undefined);
  }, [router]);
  useEffect(() => {
    if (!sent) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [sent]);

  const ask = async (channel: Channel) => {
    const ok = way === 'phone' ? looksLikeMobile(typed) : looksLikeEmail(typed);
    if (!ok) {
      setError(way === 'phone' ? 'Type your 10-digit mobile number.' : 'Type your email address.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ address: string; shown: string; expiresAt: number }>('/code', {
        address: typed,
        channel,
      });
      setSent({ ...r, channel });
      setCode('');
      setNow(Date.now() / 1000);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!sent) return;
    if (!looksLikeCode(code)) {
      setError('The code has 6 digits.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api<Me>('/sign-in', { address: sent.address, code });
      router.replace(backTo(new URLSearchParams(window.location.search).get('next')));
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };

  const switchTo = (w: Way) => {
    setWay(w);
    setTyped('');
    setError('');
  };

  return (
    <main className="narrow">
      <div className="rc-card stack">
        <h1 className="brand">RECALL</h1>
        <p className="muted">
          Moving screens on bikes across Hyderabad. Sign in to book, pay, add your ads and get your
          report.
        </p>

        {!sent ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(way === 'phone' ? 'whatsapp' : 'email');
            }}
          >
            <div className="row" role="group" aria-label="Sign in with">
              <button
                type="button"
                className="rc-chip"
                aria-pressed={way === 'phone'}
                onClick={() => switchTo('phone')}
              >
                Mobile number
              </button>
              <button
                type="button"
                className="rc-chip"
                aria-pressed={way === 'email'}
                onClick={() => switchTo('email')}
              >
                Email
              </button>
            </div>
            <label className="rc-field">
              <span className="rc-field__label">
                {way === 'phone' ? 'Mobile number' : 'Work email'}
              </span>
              <input
                className="rc-input"
                name="address"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                {...(way === 'phone'
                  ? {
                      type: 'tel',
                      inputMode: 'tel',
                      autoComplete: 'tel',
                      placeholder: '98480 12345',
                    }
                  : { type: 'email', autoComplete: 'email', placeholder: 'you@agency.in' })}
                required
              />
              {way === 'email' && (
                <span className="rc-field__help">For agencies and teams that use email.</span>
              )}
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="rc-button rc-button--primary" disabled={busy} type="submit">
              {way === 'phone' ? 'Send code on WhatsApp' : 'Send code by email'}
            </button>
            {way === 'phone' && (
              <button
                className="rc-button rc-button--quiet"
                disabled={busy}
                type="button"
                onClick={() => void ask('sms')}
              >
                No WhatsApp? Send by SMS
              </button>
            )}
          </form>
        ) : (
          <form className="stack" onSubmit={signIn}>
            <p>
              We sent a 6-digit code{' '}
              {sent.channel === 'whatsapp'
                ? 'on WhatsApp'
                : sent.channel === 'sms'
                  ? 'by SMS'
                  : 'by email'}{' '}
              to <b>{sent.shown}</b>.
            </p>
            <label className="rc-field">
              <span className="rc-field__label">Code</span>
              <input
                className="rc-input"
                name="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                autoFocus
                required
              />
              <span className="rc-field__help">
                {sent.expiresAt > now
                  ? `Works for ${timeLeft(sent.expiresAt - now)} more.`
                  : 'This code has run out: ask for a new one.'}
              </span>
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="rc-button rc-button--primary" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="row">
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => void ask(sent.channel)}
              >
                Send a new code
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setSent(undefined);
                  setError('');
                }}
              >
                {way === 'phone' ? 'Change number' : 'Change email'}
              </button>
            </div>
          </form>
        )}
        <p className="muted">
          By signing in you agree to RECALL&apos;s terms. We never ask for your code on a call.
        </p>
      </div>
    </main>
  );
}
