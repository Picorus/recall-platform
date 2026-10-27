'use client';
// P3.16 Audit log: who changed what and when, across the whole business, newest first. A super admin
// searches it by words, part of the business and dates, reads more, and downloads it as a file.
// Nothing here can change anything: every record behind it is never edited or deleted.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';

interface AuditRow {
  readonly at: number;
  readonly who: string;
  readonly area: string;
  readonly action: string;
  readonly ref: string;
  readonly detail: string;
}

interface Page {
  readonly rows: readonly AuditRow[];
  readonly next: string | null;
  readonly areas: readonly string[];
}

const failed = (e: unknown) => (e instanceof ApiError ? e.message : 'Could not load the log.');

export default function AuditPage() {
  const me = useMember();
  const [rows, setRows] = useState<readonly AuditRow[]>([]);
  const [areas, setAreas] = useState<readonly string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback((q: string, before: string | null) => {
    setBusy(true);
    api<Page>(`/audit?${q}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
      .then((p) => {
        setRows((r) => (before ? [...r, ...p.rows] : p.rows));
        setAreas(p.areas);
        setNext(p.next);
        setError('');
      })
      .catch((e: unknown) => setError(failed(e)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => {
    if (me) load('', null);
  }, [me, load]);
  const search = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const q = new URLSearchParams();
    for (const k of ['q', 'area', 'from', 'to']) {
      const v = String(f.get(k) ?? '').trim();
      if (v) q.set(k, v);
    }
    setQuery(q.toString());
    load(q.toString(), null);
  };
  const download = () => {
    api<{ name: string; csv: string; cut: boolean }>(`/audit/export?${query}`)
      .then((x) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([x.csv], { type: 'text/csv;charset=utf-8' }));
        a.download = x.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        setError(
          x.cut
            ? 'The file has the newest 10,000 entries only: narrow the search for the rest.'
            : '',
        );
      })
      .catch((e: unknown) => setError(failed(e)));
  };
  if (!me) return <p className="muted">Loading…</p>;
  return (
    <Shell member={me}>
      <h1>Audit log</h1>
      <p className="muted">
        Every change and decision, who made it and when. Nothing in it can be edited or deleted.
      </p>
      <form className="cal-bar" onSubmit={search} aria-label="Search the log">
        <label className="rc-field">
          <span className="rc-field__label">Find (who, what, booking, rider…)</span>
          <input className="rc-input" name="q" maxLength={200} />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Part</span>
          <select className="rc-input" name="area" defaultValue="">
            <option value="">All</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">From</span>
          <input className="rc-input" type="date" name="from" />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">To</span>
          <input className="rc-input" type="date" name="to" />
        </label>
        <button className="rc-button" type="submit" disabled={busy}>
          Search
        </button>
        <button className="rc-button rc-button--secondary" type="button" onClick={download}>
          Download
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 && !busy && <p className="muted">Nothing found.</p>}
      {rows.length > 0 && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Audit log">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Part</th>
                <th>What</th>
                <th>About</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    {dayOfIndia(r.at)}, {clock(r.at)}
                  </td>
                  <td>{r.who}</td>
                  <td>{r.area}</td>
                  <td>{r.action}</td>
                  <td className="mono">{r.ref}</td>
                  <td>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <button
          className="rc-button rc-button--secondary"
          type="button"
          disabled={busy}
          onClick={() => load(query, next)}
        >
          Show older
        </button>
      )}
    </Shell>
  );
}
