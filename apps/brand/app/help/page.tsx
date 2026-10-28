'use client';
// P5.9 Help: plain answers to what brands ask most, our numbers (call or WhatsApp) and hours, the
// ad rules, and a question to our team (the reply comes by WhatsApp or email).
import { Fold } from '@recall/web-ui';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Help } from '../../lib/api';
import { Shell, useMe } from '../../lib/session';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const STATE = { open: 'With our team', waiting: 'Waiting for you', done: 'Answered' } as const;
const dateOf = (t: number) =>
  new Date((t + 19_800) * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
/** "+919848012345" → "+91 98480 12345". */
const phoneText = (p: string) => `${p.slice(0, 3)} ${p.slice(3, 8)} ${p.slice(8)}`;

export default function HelpPage() {
  const me = useMe();
  const [brand, setBrand] = useState('');
  const [page, setPage] = useState<Help>();
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (b: string) =>
    api<Help>(`/help?brand=${encodeURIComponent(b)}`)
      .then(setPage)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('brand') ?? '';
    setBrand(b);
    void load(b);
  }, []);

  const ask = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError('');
    setDone('');
    try {
      await api(`/help?brand=${encodeURIComponent(brand)}`, {
        subject: String(f.get('subject') ?? ''),
        text: String(f.get('text') ?? ''),
      });
      form.reset();
      setDone(`Sent. Our team answers on ${me?.address.includes('@') ? 'email' : 'WhatsApp'}.`);
      await load(brand);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const days =
    page && page.days.length === 7
      ? 'Every day'
      : (page?.days.map((d) => DAYS[d - 1]).join(', ') ?? '');
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Help</h1>
        <Link className="back-link" href={`/campaigns?brand=${encodeURIComponent(brand)}`}>
          Back to campaigns
        </Link>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="ok" role="status">
          {done}
        </p>
      )}
      {page && (
        <div className="book">
          <div className="stack">
            <section className="stack" aria-label="Questions and answers">
              <h2>Questions and answers</h2>
              {page.answers.map((x) => (
                <Fold key={x.q} title={x.q}>
                  <p>{x.a}</p>
                </Fold>
              ))}
            </section>
            <form className="rc-card stack" onSubmit={(e) => void ask(e)} aria-label="Ask us">
              <h2>Ask us</h2>
              <label className="rc-field">
                <span className="rc-field__label">What it is about</span>
                <input className="rc-input" name="subject" minLength={3} maxLength={120} required />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Your question</span>
                <textarea
                  className="rc-input"
                  name="text"
                  rows={5}
                  minLength={5}
                  maxLength={4000}
                  required
                />
              </label>
              <button className="rc-button rc-button--primary" type="submit" disabled={busy}>
                {busy ? 'Sending…' : 'Send to our team'}
              </button>
            </form>
            {page.questions.length > 0 && (
              <section className="stack" aria-label="Your questions">
                <h2>Your questions</h2>
                <ul className="plain">
                  {page.questions.map((x) => (
                    <li key={`${x.at}-${x.subject}`} className="row">
                      <span className="muted">{dateOf(x.at)}</span>
                      <span>{x.subject}</span>
                      <span className={x.state === 'done' ? 'muted' : 'ok'}>{STATE[x.state]}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <aside className="stack">
            <section className="rc-card stack" aria-label="Call or WhatsApp us">
              <h2>Call or WhatsApp us</h2>
              <p className={page.open ? 'ok' : 'muted'}>
                {page.open ? 'Open now' : 'Closed now'} · {days}, {page.opens} to {page.closes}
              </p>
              {page.phones.length === 0 && (
                <p className="muted">Our numbers are being set up: ask us here meanwhile.</p>
              )}
              {page.phones.map((p) => (
                <div key={p.phone} className="row">
                  <span>{p.label}</span>
                  <a href={`tel:${p.phone}`}>{phoneText(p.phone)}</a>
                  {p.whatsapp && (
                    <a
                      href={`https://wa.me/${p.phone.slice(1)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      WhatsApp
                    </a>
                  )}
                </div>
              ))}
            </section>
            <section aria-label="Ad rules">
              <Fold title="Ad rules" hint={`${page.adRules.length} rules every ad must follow`}>
                <ul className="tips">
                  {page.adRules.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </Fold>
            </section>
          </aside>
        </div>
      )}
    </Shell>
  );
}
