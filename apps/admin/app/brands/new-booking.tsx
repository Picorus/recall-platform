'use client';
// P3.8.2: a Sales admin books for a brand: one area, a run of days, chosen start hours and the same
// bikes in each; any start date (staff can book last-minute; the 15 days are for the portal). The
// price comes back at once; the booking is a draft (keeps no bikes) until it is sent for payment.
import { Info } from '@recall/web-ui';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../lib/api';
import { linesOf } from '../../lib/bookings';
import { hourLabel, START_HOURS } from '../../lib/prices';

export default function NewBooking({
  brandId,
  onMade,
}: {
  readonly brandId: string;
  readonly onMade: (bookingId: string) => void;
}) {
  const [areas, setAreas] = useState<readonly { areaId: string; name: string }[]>([]);
  const [hours, setHours] = useState<number[]>([]);
  // Deal offers come from the prices in force (a setting), never from this page.
  const [offers, setOffers] = useState<readonly number[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ areas: { areaId: string; name: string }[] }>('/calendar')
      .then((r) => setAreas(r.areas))
      .catch(() => setError('Could not load the areas.'));
    api<{
      inForce: number | null;
      versions: { version: number; book: { repeatOffersBp: Record<string, number> } }[];
    }>('/prices')
      .then((r) => {
        const inForce = r.versions.find((v) => v.version === r.inForce);
        setOffers(Object.keys(inForce?.book.repeatOffersBp ?? {}).map(Number));
      })
      .catch(() => setOffers([]));
  }, []);

  const make = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const bikes = String(f.get('bikes') ?? '');
    const r = linesOf(
      String(f.get('area') ?? ''),
      String(f.get('from') ?? ''),
      String(f.get('to') ?? ''),
      hours,
      /^\d{1,6}$/.test(bikes) ? Number(bikes) : NaN,
    );
    if ('problem' in r) return setError(r.problem);
    setBusy(true);
    setError('');
    api<{ bookingId: string; total: number }>('/bookings', {
      brandId,
      lines: r.lines,
      repeatMonths: Number(f.get('months') ?? 1),
    })
      .then((x) => onMade(x.bookingId))
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not reach the server.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form className="rc-card stack" onSubmit={make} aria-label="New booking">
      <h3 style={{ margin: 0 }}>New booking</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="tiles">
        <label className="rc-field">
          <span className="rc-field__label">Area</span>
          <select className="rc-input" name="area" required>
            {areas.map((a) => (
              <option key={a.areaId} value={a.areaId}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="rc-field">
          <span className="rc-field__label">First day</span>
          <input className="rc-input" name="from" type="date" required />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Last day</span>
          <input className="rc-input" name="to" type="date" required />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Bikes in each hour</span>
          <input className="rc-input" name="bikes" inputMode="numeric" required />
        </label>
        <label className="rc-field">
          <span className="rc-field__label">Deal</span>
          <select className="rc-input" name="months" defaultValue="1">
            <option value="1">One booking</option>
            {offers.map((m) => (
              <option key={m} value={m}>
                {m}-month deal
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="areas">
        <legend>Start hours</legend>
        {START_HOURS.map((h) => (
          <label key={h}>
            <input
              type="checkbox"
              checked={hours.includes(h)}
              onChange={() =>
                setHours(hours.includes(h) ? hours.filter((x) => x !== h) : [...hours, h])
              }
            />
            {hourLabel(h)}
          </label>
        ))}
      </fieldset>
      <Info label="How this works">
        Priced at the prices in force now, with GST added. It is a draft, keeping no bikes, until
        you send the payment link.
      </Info>
      <button className="rc-button" type="submit" disabled={busy}>
        Make the booking
      </button>
    </form>
  );
}
