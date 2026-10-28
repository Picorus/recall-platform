'use client';
// P3.14.2 Dashboard: the business month by month (India time), for the founder and sales. Bike-hours
// sold, how full the screens' time was, bike-hours moving, money in, revenue earned, refunds.
import { Info } from '@recall/web-ui';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { count, rupees } from '../../lib/format';
import { Shell, useMember } from '../../lib/session';

interface MonthNumbers {
  readonly month: string;
  readonly bookingsPaid: number;
  readonly soldBikeHours: number;
  readonly screenBikeHours: number;
  readonly movingBikeHours: number;
  readonly fillBp: number | null;
  readonly moneyInPaise: number;
  readonly revenuePaise: number;
  readonly refunds: number;
  readonly refundsPaise: number;
  readonly refundsBp: number | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 2026" from "2026-10". */
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;
const pct = (bp: number | null) => (bp === null ? '–' : `${(bp / 100).toFixed(1)}%`);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rc-stat">
      <span className="rc-stat__label">{label}</span>
      <span className="rc-stat__value">{value}</span>
      {note && <span className="rc-stat__note">{note}</span>}
    </div>
  );
}

export default function DashboardPage() {
  const me = useMember();
  const [months, setMonths] = useState<readonly MonthNumbers[]>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ months: MonthNumbers[] }>('/dashboard?count=6')
      .then((x) => {
        setMonths(x.months);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the numbers.'),
      );
  }, []);
  useEffect(() => {
    if (me) load();
  }, [me, load]);
  if (!me) return <p className="muted">Loading…</p>;
  const now = months?.at(-1);
  return (
    <Shell member={me}>
      <h1>Dashboard</h1>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {now && (
        <section className="stack" aria-label="This month">
          <h2 style={{ margin: 0 }}>{monthName(now.month)} so far</h2>
          <div className="tiles">
            <Stat
              label="Bike-hours sold"
              value={count(now.soldBikeHours)}
              note={`${count(now.bookingsPaid)} bookings paid this month`}
            />
            <Stat
              label="Screen time sold"
              value={pct(now.fillBp)}
              note={`of ${count(now.screenBikeHours)} bike-hours the screens were out, days gone by`}
            />
            <Stat
              label="Moving"
              value={`${count(now.movingBikeHours)} h`}
              note="bike-hours the screens were moving"
            />
            <Stat
              label="Money in"
              value={rupees(now.moneyInPaise)}
              note="paid by brands, with GST"
            />
            <Stat
              label="Revenue earned"
              value={rupees(now.revenuePaise)}
              note="as plays were delivered"
            />
            <Stat
              label="Refunds"
              value={rupees(now.refundsPaise)}
              note={`${count(now.refunds)} approved · ${pct(now.refundsBp)} of revenue`}
            />
          </div>
        </section>
      )}
      {months && (
        <div className="rc-table-wrap">
          <table className="rc-table" aria-label="Month by month">
            <thead>
              <tr>
                <th>Month</th>
                <th>Bike-hours sold</th>
                <th>Screen time sold</th>
                <th>Moving (h)</th>
                <th>Money in</th>
                <th>Revenue earned</th>
                <th>Refunds</th>
              </tr>
            </thead>
            <tbody>
              {[...months].reverse().map((m) => (
                <tr key={m.month}>
                  <td>{monthName(m.month)}</td>
                  <td className="mono">{count(m.soldBikeHours)}</td>
                  <td className="mono">{pct(m.fillBp)}</td>
                  <td className="mono">{count(m.movingBikeHours)}</td>
                  <td className="mono">{rupees(m.moneyInPaise)}</td>
                  <td className="mono">{rupees(m.revenuePaise)}</td>
                  <td className="mono">
                    {rupees(m.refundsPaise)} ({pct(m.refundsBp)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Info label="How this works">
        Brands pay by bike-hours only. Screen time sold compares bike-hours sold for days already
        over with the hours the screens were out.
      </Info>
    </Shell>
  );
}
