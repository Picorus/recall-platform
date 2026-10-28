'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { sixDigits, tidyBox } from '../../lib/format';

export default function SignIn() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/staff/sign-in', {
        email: String(f.get('email') ?? ''),
        password: String(f.get('password') ?? ''),
        code: String(f.get('code') ?? ''),
      });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <form className="rc-card stack" onSubmit={submit}>
        <h1 className="brand">RECALL admin</h1>
        <label className="rc-field">
          <span className="rc-field__label">Email</span>
          <input className="rc-input" name="email" type="email" autoComplete="username" required />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Password</span>
          <input
            className="rc-input"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Code from your authenticator app</span>
          <input
            className="rc-input rc-input--code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            onChange={tidyBox(sixDigits)}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="rc-button rc-button--primary" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted">
          Lost your phone or password? Ask a super admin to reset your account.
        </p>
      </form>
    </main>
  );
}
