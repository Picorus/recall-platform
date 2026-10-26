'use client';
// P3.11.3: fitting slots at the warehouse, from now on, with who is booked; an Operations admin opens
// one (a centre, a start in India time, how long, how many bikes). Riders are booked from their panel.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { clock, dayOfIndia } from '../../lib/format';
import { slotText, type FittingSlot } from '../../lib/riders';

const when = (s: number) => `${dayOfIndia(s)} ${clock(s)}`;

export default function FittingSlots({
  canAct,
  onChanged,
}: {
  readonly canAct: boolean;
  /** A slot was opened (a rider's panel shows the new choice). */
  readonly onChanged: () => void;
}) {
  const [slots, setSlots] = useState<readonly FittingSlot[]>();
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ slots: FittingSlot[] }>('/riders/slots')
      .then((x) => setSlots(x.slots))
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the slots.'),
      );
  }, []);
  useEffect(load, [load]);
  const open = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError('');
    setNote('');
    api('/riders/slots', {
      centre: String(f.get('centre') ?? ''),
      startsAt: String(f.get('startsAt') ?? ''),
      minutes: Number(f.get('minutes')),
      bikes: Number(f.get('bikes')),
    })
      .then(() => {
        setNote('Slot opened.');
        load();
        onChanged();
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };
  return (
    <section className="rc-card stack" aria-label="Fitting slots">
      <h2 style={{ margin: 0 }}>Fitting slots</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {slots && slots.length === 0 && <p className="muted">No slots open.</p>}
      <ul className="plain">
        {slots?.map((s) => (
          <li key={s.slotId}>
            {slotText(s, when)}
            {s.booked.length > 0 && <span className="muted"> · {s.booked.join(', ')}</span>}
          </li>
        ))}
      </ul>
      {canAct && (
        <form className="cal-bar" onSubmit={open} aria-label="Open a fitting slot">
          <label className="rc-field">
            <span className="rc-field__label">Centre</span>
            <input className="rc-input" name="centre" maxLength={80} required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Starts (India time)</span>
            <input className="rc-input" name="startsAt" type="datetime-local" required />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Minutes</span>
            <input
              className="rc-input"
              name="minutes"
              type="number"
              min={15}
              max={480}
              defaultValue={120}
            />
          </label>
          <label className="rc-field">
            <span className="rc-field__label">Bikes</span>
            <input
              className="rc-input"
              name="bikes"
              type="number"
              min={1}
              max={100}
              defaultValue={4}
            />
          </label>
          <button className="rc-button rc-button--secondary" type="submit" disabled={busy}>
            Open slot
          </button>
        </form>
      )}
    </section>
  );
}
