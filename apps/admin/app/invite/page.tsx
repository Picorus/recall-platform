'use client';
// A one-time invite: set a password and add RECALL to an authenticator app (scan the QR code or
// type the key), then confirm with the app's code.
import Link from 'next/link';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';

interface Invite {
  readonly email: string;
  readonly name: string;
  readonly secret: string;
  readonly otpauth: string;
}

export default function AcceptInvite() {
  const [token, setToken] = useState('');
  const [invite, setInvite] = useState<Invite>();
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The token is after # in the link: browsers never send that part to any server.
    const t = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
    setToken(t);
    api<Invite>('/staff/invite/open', { token: t })
      .then(async (inv) => {
        setInvite(inv);
        setQr(await QRCode.toDataURL(inv.otpauth, { margin: 1, width: 220 }));
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, []);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password') ?? '');
    if (password !== String(f.get('again') ?? ''))
      return setError('The two passwords are not the same.');
    setBusy(true);
    setError('');
    try {
      await api('/staff/invite', { token, password, code: String(f.get('code') ?? '') });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <main className="narrow rc-card stack">
        <h1>All set</h1>
        <p>Your password and two-step code are ready.</p>
        <Link className="rc-button rc-button--primary" href="/sign-in">
          Sign in
        </Link>
      </main>
    );
  if (!invite)
    return (
      <main className="narrow">
        <p className={error ? 'error' : 'muted'}>{error || 'Loading…'}</p>
      </main>
    );
  return (
    <main className="narrow">
      <form className="rc-card stack" onSubmit={submit}>
        <h1>Welcome, {invite.name}</h1>
        <p className="muted">{invite.email}</p>
        <label className="rc-field">
          <span className="rc-field__label">New password</span>
          <input
            className="rc-input"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
          <span className="rc-field__help">
            At least 12 characters. A few words with a number works well.
          </span>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Password again</span>
          <input
            className="rc-input"
            name="again"
            type="password"
            autoComplete="new-password"
            required
          />
        </label>
        <p>
          In Google Authenticator (or any authenticator app), add an account and scan this code:
        </p>
        {qr && <img src={qr} alt="QR code for your authenticator app" width={220} height={220} />}
        <p className="muted">
          Or type this key: <span className="mono">{invite.secret}</span>
        </p>
        <label className="rc-field">
          <span className="rc-field__label">The 6-digit code the app shows</span>
          <input
            className="rc-input"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="rc-button rc-button--primary" disabled={busy} type="submit">
          Save
        </button>
      </form>
    </main>
  );
}
