'use client';
// P3.8.2: one booking for staff: its lines and money, the payment link (send, copy, check), the
// timeline of everything that happened, cancel with a reason, and notes. A Sales admin acts; Sales,
// Finance and Support look.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { STEP_NAMES } from '../../lib/brands';
import { linkText } from '../../lib/bookings';
import { clock, dayName, dayOfIndia, rupees } from '../../lib/format';
import { hourLabel } from '../../lib/prices';
import BookingAds from './booking-ads';

interface Booking {
  readonly bookingId: string;
  readonly state: string;
  readonly trial: boolean;
  readonly repeatMonths: number;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly firstHourAt: number;
  readonly adsDueAt: number;
  readonly lines: readonly {
    areaId: string;
    date: string;
    startHour: number;
    bikes: number;
    paise: number;
  }[];
  readonly link: {
    linkId: string;
    url: string;
    expiresAt: number;
    amountPaise: number;
    states: readonly string[];
  } | null;
  readonly timeline: readonly { at: number; kind: string; text: string; by: string | null }[];
}

const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;

/** What "Check payment" found, in words. */
const CHECKED: Record<string, string> = {
  paid: 'Paid.',
  already: 'Paid.',
  waiting: 'Not paid yet.',
  expired: 'The link ran out unpaid: the booking is cancelled and its bikes are back on sale.',
  'paid-late': 'Money arrived that cannot be kept: finance will send it back.',
  'wrong-amount': 'A wrong amount was paid: finance will send it back. The booking still waits.',
  unknown: 'No payment link yet.',
};
const PAID = ['paid', 'ads-approved'];

export default function BookingPanel({
  bookingId,
  brandId,
  canAct,
  onChange,
}: {
  readonly bookingId: string;
  readonly brandId: string;
  readonly canAct: boolean;
  readonly onChange: () => void;
}) {
  const [b, setB] = useState<Booking>();
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ at: number; booking: Booking }>(`/bookings/${bookingId}`)
      .then((r) => {
        setB(r.booking);
        setAt(r.at);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      );
  }, [bookingId]);
  useEffect(load, [load]);

  const call = (f: () => Promise<string>) => {
    setBusy(true);
    setError('');
    setNote('');
    f()
      .then((done) => {
        setNote(done);
        load();
        onChange();
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };
  if (!b) return <p className="muted">{error || 'Loading…'}</p>;
  const open = b.state === 'draft' || b.state === 'awaiting-payment';
  const linkOpen = b.link !== null && b.link.states.length === 0 && at < b.link.expiresAt;

  const send = () =>
    call(async () => {
      const l = await api<{ url: string }>(`/bookings/${b.bookingId}/send`, {});
      return `Payment link ready: ${l.url}`;
    });
  const check = () =>
    call(async () => {
      const r = await api<{ outcome: string }>(`/bookings/${b.bookingId}/check`, {});
      return CHECKED[r.outcome] ?? 'Not paid yet.';
    });
  const cancel = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    call(async () => {
      await api(`/bookings/${b.bookingId}/cancel`, { reason });
      return 'Booking cancelled; its bikes are back on sale.';
    });
  };
  const addNote = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get('note') ?? '');
    call(async () => {
      await api(`/bookings/${b.bookingId}/notes`, { note: text });
      form.reset();
      return 'Note added.';
    });
  };

  return (
    <section className="rc-card stack" aria-label={`Booking ${b.bookingId}`}>
      <h3 style={{ margin: 0 }}>
        Booking <span className="mono">{b.bookingId}</span> · {STEP_NAMES[b.state] ?? b.state}
        {b.trial ? ' · free trial' : ''}
      </h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      <dl className="facts">
        <dt>First hour</dt>
        <dd>{when(b.firstHourAt)}</dd>
        <dt>Ads due</dt>
        <dd>{when(b.adsDueAt)}</dd>
        <dt>Money</dt>
        <dd>
          {rupees(b.subtotalPaise)} + GST {rupees(b.gstPaise)} ={' '}
          <strong>{rupees(b.totalPaise)}</strong>
          {b.repeatMonths > 1 ? ` · ${b.repeatMonths}-month deal` : ''}
        </dd>
        <dt>Payment</dt>
        <dd>
          {linkText(b.link, at)}
          {b.link && linkOpen && (
            <>
              {' '}
              · until {when(b.link.expiresAt)} ·{' '}
              <a href={b.link.url} target="_blank" rel="noreferrer">
                {b.link.url}
              </a>
            </>
          )}
        </dd>
      </dl>
      <details>
        <summary>
          {b.lines.length} area-hour{b.lines.length === 1 ? '' : 's'}
        </summary>
        <ul className="plain">
          {b.lines.map((l) => (
            <li key={`${l.areaId}|${l.date}|${l.startHour}`}>
              {l.areaId} · {dayName(l.date)} {hourLabel(l.startHour)} · {l.bikes} bikes ·{' '}
              {rupees(l.paise)}
            </li>
          ))}
        </ul>
      </details>
      {canAct && open && !b.trial && (
        <div className="cal-bar">
          {(b.state === 'draft' || linkOpen || b.link === null) && (
            <button className="rc-button" type="button" onClick={send} disabled={busy}>
              {linkOpen ? 'Show the link again' : 'Send payment link'}
            </button>
          )}
          {b.state === 'awaiting-payment' && (
            <button
              className="rc-button rc-button--secondary"
              type="button"
              onClick={check}
              disabled={busy}
            >
              Check payment
            </button>
          )}
        </div>
      )}
      {canAct && b.state !== 'cancelled' && at < b.firstHourAt && (
        <form className="cal-bar" onSubmit={cancel} aria-label="Cancel booking">
          {PAID.includes(b.state) && (
            <p className="error" style={{ flexBasis: '100%' }}>
              This booking is paid. Cancelling does not refund it by itself: a refund needs a super
              admin’s approval and is only possible when cancelled early enough before the first
              hour.
            </p>
          )}
          <label className="rc-field">
            <span className="rc-field__label">Why cancel (logged)</span>
            <input className="rc-input" name="reason" minLength={3} maxLength={200} required />
          </label>
          <button className="rc-button rc-button--quiet" type="submit" disabled={busy}>
            Cancel booking
          </button>
        </form>
      )}
      {b.state !== 'cancelled' && (
        <BookingAds
          bookingId={b.bookingId}
          brandId={brandId}
          canAct={canAct && at < b.firstHourAt}
        />
      )}
      <h4 style={{ margin: 0 }}>Timeline</h4>
      <ul className="plain" aria-label="Timeline">
        {b.timeline.map((t, i) => (
          <li key={i}>
            {t.text}
            <div className="muted">
              {when(t.at)}
              {t.by ? ` · ${t.by}` : ''}
            </div>
          </li>
        ))}
      </ul>
      {canAct && (
        <form className="stack" onSubmit={addNote} aria-label="Booking note">
          <label className="rc-field">
            <span className="rc-field__label">Add a note to this booking</span>
            <textarea className="rc-input" name="note" rows={2} maxLength={2000} required />
          </label>
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Add note
          </button>
        </form>
      )}
    </section>
  );
}
