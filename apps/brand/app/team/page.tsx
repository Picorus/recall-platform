'use client';
// P5.9 Team: who can use this business on the portal. Owners add people by mobile number or work
// email (they sign in with a code), choose "owner" or "can book", and remove them; never
// themselves. "Can book" people book, add ads and pay; owners also manage the team.
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Team } from '../../lib/api';
import { Shell, useMe } from '../../lib/session';

const ROLE = { owner: 'Owner', booker: 'Can book' } as const;

export default function TeamPage() {
  const me = useMe();
  const [brand, setBrand] = useState('');
  const [page, setPage] = useState<Team>();
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (b: string) =>
    api<Team>(`/team?brand=${encodeURIComponent(b)}`)
      .then(setPage)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server. Try again.'),
      );
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get('brand') ?? '';
    setBrand(b);
    void load(b);
  }, []);

  const change = async (body: { address: string; role: string; active: boolean }, ok: string) => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await api(`/team?brand=${encodeURIComponent(brand)}`, body);
      setDone(ok);
      await load(brand);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const address = String(f.get('address') ?? '').trim();
    if (
      await change(
        { address, role: String(f.get('role') ?? 'booker'), active: true },
        `${address} can now sign in with a code and use ${page?.account.name ?? 'this business'}.`,
      )
    )
      form.reset();
  };

  if (!me)
    return (
      <main className="narrow">
        <p className="muted">Loading…</p>
      </main>
    );
  const owner = page?.account.role === 'owner';
  return (
    <Shell me={me}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Team</h1>
        <Link href={`/campaigns?brand=${encodeURIComponent(brand)}`}>Back to campaigns</Link>
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
        <>
          <p className="muted">
            People who can use {page.account.name} on the portal. &ldquo;Can book&rdquo; people
            book, add ads and pay; owners also manage this team.
          </p>
          {page.agency && (
            <p className="muted">
              People at your agency, {page.agency}, can also book and add ads for you. Ask us on
              Help to change your agency.
            </p>
          )}
          <ul className="plain" aria-label="People">
            {page.team.map((m) => (
              <li
                key={m.address}
                className="rc-card row"
                style={{ justifyContent: 'space-between' }}
              >
                <span>
                  <b>{m.shown}</b> {m.address === page.me && <span className="muted">(you)</span>}
                </span>
                <span className="row">
                  {owner && m.address !== page.me ? (
                    <>
                      <select
                        className="rc-input"
                        aria-label={`Role of ${m.shown}`}
                        value={m.role}
                        disabled={busy}
                        onChange={(e) =>
                          void change(
                            { address: m.address, role: e.target.value, active: true },
                            `${m.shown} is now: ${ROLE[e.target.value as 'owner' | 'booker']}.`,
                          )
                        }
                      >
                        <option value="booker">{ROLE.booker}</option>
                        <option value="owner">{ROLE.owner}</option>
                      </select>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() =>
                          void change(
                            { address: m.address, role: m.role, active: false },
                            `${m.shown} no longer has access.`,
                          )
                        }
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <span className="muted">{ROLE[m.role]}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {owner ? (
            <form className="rc-card stack" onSubmit={(e) => void add(e)} aria-label="Add a person">
              <h2>Add a person</h2>
              <label className="rc-field">
                <span className="rc-field__label">Mobile number or work email</span>
                <input className="rc-input" name="address" maxLength={254} required />
              </label>
              <label className="rc-field">
                <span className="rc-field__label">Access</span>
                <select className="rc-input" name="role" defaultValue="booker">
                  <option value="booker">{ROLE.booker}</option>
                  <option value="owner">{ROLE.owner}</option>
                </select>
              </label>
              <button
                className="rc-button rc-button--primary"
                type="submit"
                disabled={busy || page.team.length >= page.max}
              >
                Add
              </button>
              <p className="muted">
                Up to {page.max} people. They sign in on this site with a code sent to that number
                or email.
              </p>
            </form>
          ) : (
            <p className="muted">Only an owner adds or removes people.</p>
          )}
        </>
      )}
    </Shell>
  );
}
