'use client';
// P3.11.1 Riders: everyone who applied or rides, newest first: find by name, phone, id or number
// plate, or by step. Operations add a rider who walks in, and open one to check his documents and
// move his steps; Support looks and adds notes.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Member } from '../../lib/api';
import { dayOfIndia } from '../../lib/format';
import {
  APPS,
  phoneText,
  STATUS_CHIP,
  STATUS_NAMES,
  type RiderRow,
  type RiderStatus,
} from '../../lib/riders';
import { Shell, useMember } from '../../lib/session';
import RiderPanel from './rider-panel';
import FittingSlots from './fitting-slots';

const isSuper = (m: Member) => m.role === 'super-admin';
const canAct = (m: Member) => isSuper(m) || (m.role === 'admin' && m.areas.includes('operations'));
const canNote = (m: Member) => canAct(m) || (m.role === 'admin' && m.areas.includes('support'));

export default function RidersPage() {
  const me = useMember();
  const [riders, setRiders] = useState<readonly RiderRow[]>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<RiderStatus | ''>('');
  const [open, setOpen] = useState('');
  const [slotsSeen, setSlotsSeen] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);

  const load = useCallback((text: string, st: string) => {
    const n = ++asked.current;
    const p = new URLSearchParams();
    if (text.trim()) p.set('q', text.trim());
    if (st) p.set('status', st);
    api<{ riders: RiderRow[] }>(`/riders${p.size ? `?${p.toString()}` : ''}`)
      .then((x) => {
        if (n !== asked.current) return;
        setRiders(x.riders);
        setError('');
      })
      .catch((e: unknown) => {
        if (n === asked.current)
          setError(e instanceof ApiError ? e.message : 'Could not load riders.');
      });
  }, []);
  useEffect(() => {
    if (me) load('', '');
  }, [me, load]);

  const add = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError('');
    api<{ riderId: string }>('/riders', {
      name: String(f.get('name') ?? ''),
      phone: String(f.get('phone') ?? ''),
      bikePlate: String(f.get('bikePlate') ?? '').trim() || null,
      rides: String(f.get('rides') ?? ''),
      apps: f.getAll('apps').map(String),
      reason: String(f.get('reason') ?? ''),
    })
      .then((x) => {
        form.reset();
        setAdding(false);
        setNote(`Rider ${x.riderId} added.`);
        setOpen(x.riderId);
        load(q, status);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };

  if (!me) return <p className="muted">Loading…</p>;
  // Only text that could be part of a name, phone, id or plate is sent (a plain query).
  const plain = (s: string) => s.replace(/[^A-Za-z0-9 -]/g, '');
  return (
    <Shell member={me}>
      <h1>Riders</h1>
      <form
        className="cal-bar"
        onSubmit={(e) => {
          e.preventDefault();
          load(q, status);
        }}
        aria-label="Find riders"
      >
        <label className="rc-field">
          <span className="rc-field__label">Name, phone, id or plate</span>
          <input
            className="rc-input"
            value={q}
            maxLength={60}
            onChange={(e) => setQ(plain(e.target.value))}
          />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Step</span>
          <select
            className="rc-input"
            value={status}
            onChange={(e) => {
              const st = e.target.value as RiderStatus | '';
              setStatus(st);
              load(q, st);
            }}
          >
            <option value="">All</option>
            {(Object.keys(STATUS_NAMES) as RiderStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_NAMES[s]}
              </option>
            ))}
          </select>
        </label>
        <button className="rc-button rc-button--secondary" type="submit">
          Find
        </button>
        {canAct(me) && (
          <button className="rc-button" type="button" onClick={() => setAdding(!adding)}>
            New rider
          </button>
        )}
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {adding && (
        <form className="rc-card stack" onSubmit={add} aria-label="New rider">
          <label className="rc-field">
            <span className="rc-field__label">Name</span>
            <input className="rc-input" name="name" maxLength={80} required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Phone (mobile)</span>
            <input className="rc-input" name="phone" maxLength={20} required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Number plate</span>
            <input className="rc-input" name="bikePlate" maxLength={16} />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Rides in</span>
            <input className="rc-input" name="rides" maxLength={120} />
          </label>
          <fieldset className="cal-bar">
            <legend className="rc-field__label">Works for</legend>
            {APPS.map((a) => (
              <label key={a}>
                <input type="checkbox" name="apps" value={a} /> {a}
              </label>
            ))}
          </fieldset>
          <label className="rc-field">
            <span className="rc-field__label">How he applied (logged)</span>
            <input className="rc-input" name="reason" minLength={3} maxLength={300} required />
          </label>
          <button className="rc-button" type="submit" disabled={busy}>
            Add rider
          </button>
        </form>
      )}
      <FittingSlots canAct={canAct(me)} onChanged={() => setSlotsSeen((n) => n + 1)} />
      {riders && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Riders">
            <thead>
              <tr>
                <th>Rider</th>
                <th>Phone</th>
                <th>Plate</th>
                <th>Step</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {riders.map((r) => (
                <tr key={r.riderId}>
                  <td>
                    <button
                      className="rc-button rc-button--quiet"
                      type="button"
                      onClick={() => setOpen(r.riderId)}
                    >
                      {r.name}
                    </button>{' '}
                    <span className="mono">{r.riderId}</span>
                  </td>
                  <td>{phoneText(r.phone)}</td>
                  <td>{r.bikePlate ?? '—'}</td>
                  <td>
                    <span className={`rc-chip ${STATUS_CHIP[r.status]}`}>
                      {STATUS_NAMES[r.status]}
                    </span>
                  </td>
                  <td>{dayOfIndia(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {riders.length === 0 && <p className="muted">No riders found.</p>}
        </div>
      )}
      {open && (
        <RiderPanel
          key={`${open}:${slotsSeen}`}
          riderId={open}
          canAct={canAct(me)}
          canNote={canNote(me)}
          onChanged={() => load(q, status)}
        />
      )}
    </Shell>
  );
}
