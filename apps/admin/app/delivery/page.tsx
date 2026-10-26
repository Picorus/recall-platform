'use client';
// P3.10 Delivery and make-ups: a business day's sold lines (08:00 to 02:00 India time): plays
// promised and counted, bikes seen, and where each stands: live, delivered, short with a make-up
// booked, or a refund proposed for a super admin to decide.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { DeliveryList } from '../../lib/delivery';
import { dayName } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';
import DeliveryLines from './delivery-lines';

interface Day extends DeliveryList {
  readonly at: number;
  readonly day: string;
}

export default function DeliveryPage() {
  const me = useMember();
  const [d, setD] = useState<Day>();
  const [refunds, setRefunds] = useState<DeliveryList>();
  const [day, setDay] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // Only the newest request's answer is shown.
  const asked = useRef(0);

  const load = useCallback((which: string) => {
    const n = ++asked.current;
    api<Day>(which ? `/delivery?day=${which}` : '/delivery')
      .then((x) => {
        if (n !== asked.current) return;
        setD(x);
        setDay(x.day);
        setError('');
      })
      .catch((e: unknown) => {
        if (n !== asked.current) return;
        setD(undefined);
        setError(e instanceof ApiError ? e.message : 'Could not load the day.');
      });
    // Refunds waiting for a super admin, whatever their day.
    api<DeliveryList>('/delivery/refunds')
      .then((r) => {
        if (n === asked.current) setRefunds(r);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (me) load('');
  }, [me, load]);

  if (!me) return <p className="muted">Loading…</p>;
  const short = d?.lines.filter(
    (l) =>
      ['short', 'short-final', 'refund-due', 'ads-missing'].includes(l.view.status) ||
      l.view.overdue,
  );
  return (
    <Shell member={me}>
      <h1>Delivery{d ? ` · ${dayName(d.day)}` : ''}</h1>
      <div className="cal-bar">
        <label className="rc-field">
          <span className="rc-field__label">Business day</span>
          <input
            className="rc-input"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              if (e.target.value) load(e.target.value);
            }}
          />
        </label>
        <button className="rc-button rc-button--secondary" type="button" onClick={() => load(day)}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {refunds && refunds.lines.length > 0 && (
        <section className="rc-card stack" aria-label="Refunds waiting">
          <h2 style={{ margin: 0 }}>Refunds waiting for a super admin ({refunds.lines.length})</h2>
          <DeliveryLines
            lines={refunds.lines}
            showBooking
            canDecide={me.role === 'super-admin'}
            onChanged={(n) => {
              setNote(n);
              load(day);
            }}
          />
        </section>
      )}
      {d && (
        <>
          <p className="muted">
            {d.lines.length} lines · {short?.length ?? 0} need attention
          </p>
          {d.truncated && (
            <p className="error">Only the first {d.lines.length} lines are shown for this day.</p>
          )}
          <DeliveryLines
            lines={d.lines}
            showBooking
            canDecide={me.role === 'super-admin'}
            onChanged={(n) => {
              setNote(n);
              load(day);
            }}
          />
        </>
      )}
    </Shell>
  );
}
