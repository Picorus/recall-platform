'use client';
// P3.14.2 Dashboard: the business month by month (India time), for the founder and sales. Bike-hours
// sold, how full the screens' time was, bike-hours moving, money in, revenue earned, refunds.
// P7.7.7: charts first (today hour by hour, the last 30 days, month by month); the numbers table
// folds away under them.
import {
  BarChart,
  dayLabel,
  Fold,
  hourLabel,
  Info,
  LineChart,
  monthLabel,
  peak,
  rupeesShort,
} from '@recall/web-ui';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { count, dayName, rupees } from '../../lib/format';
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

interface Trends {
  readonly at: number;
  readonly day: string;
  readonly hours: readonly { hour: number; at: number; plays: number; screens: number }[];
  readonly days: readonly {
    day: string;
    plays: number;
    screenBikeHours: number;
    moneyInPaise: number;
    revenuePaise: number;
  }[];
}

/** "7–8pm" for the hour starting at an India hour. */
const hourSpan = (h: number) => `${hourLabel(h).replace(/[ap]m$/, '')}–${hourLabel(h + 1)}`;

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
  const [trends, setTrends] = useState<Trends>();
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api<{ months: MonthNumbers[] }>('/dashboard?count=12')
      .then((x) => {
        setMonths(x.months);
        setError('');
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the numbers.'),
      );
    api<Trends>('/dashboard/trends?days=30')
      .then(setTrends)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.message : 'Could not load the charts.'),
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
      {trends && <TodayCharts t={trends} />}
      {trends && <DaysCharts t={trends} />}
      {months && <MonthsChart months={months} />}
      {months && (
        <Fold
          title="Month by month, in numbers"
          hint={`${months.length} months, ${monthName(months[0]?.month ?? '')} to ${monthName(months.at(-1)?.month ?? '')}`}
        >
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
        </Fold>
      )}
      <Info label="How this works">
        Brands pay by bike-hours only. Screen time sold compares bike-hours sold for days already
        over with the hours the screens were out.
      </Info>
    </Shell>
  );
}

/** Today hour by hour, 8am to 2am India time: brand ads played and screens on. */
function TodayCharts({ t }: { t: Trends }) {
  // Hours not yet begun are left off (an empty hour later today is not a fall to 0).
  const hours = t.hours.filter((h) => h.at <= t.at);
  const points = (pick: (h: Trends['hours'][number]) => number) =>
    hours.map((h) => ({
      label: hourLabel(h.hour),
      full: `${dayName(t.day)}, ${hourSpan(h.hour)}`,
      value: pick(h),
    }));
  const plays = points((h) => h.plays);
  const screens = points((h) => h.screens);
  const busiest = peak(plays);
  const mostOut = peak(screens);
  const totalPlays = hours.reduce((n, h) => n + h.plays, 0);
  return (
    <section className="stack" aria-labelledby="today-charts">
      <h2 id="today-charts" style={{ margin: 0 }}>
        Today · {dayName(t.day)}
      </h2>
      <div className="rc-chart-grid">
        <div className="rc-chart-card">
          <BarChart
            title="Brand ads played, hour by hour"
            summary={
              totalPlays === 0
                ? 'None yet today'
                : `${count(totalPlays)} so far · busiest ${busiest ? hourSpan(hours[plays.indexOf(busiest)]?.hour ?? 8) : ''}`
            }
            points={plays}
            format={count}
            axisFormat={(v) => count(v)}
            valueName="Plays"
            empty="No ads played yet today."
          />
        </div>
        <div className="rc-chart-card">
          <LineChart
            area
            title="Screens on the road, hour by hour"
            summary={
              mostOut && mostOut.value > 0
                ? `Most at once: ${count(mostOut.value)} (${mostOut.full?.split(', ')[1] ?? ''})`
                : 'No screen on yet today'
            }
            points={screens}
            format={(v) => `${count(v)} screens`}
            axisFormat={count}
            valueName="Screens"
            empty="No screen has been on yet today."
          />
        </div>
      </div>
    </section>
  );
}

/** The last 30 business days: money brands paid and revenue earned as plays were delivered. */
function DaysCharts({ t }: { t: Trends }) {
  const days = (pick: (d: Trends['days'][number]) => number) =>
    t.days.map((d) => ({ label: dayLabel(d.day), full: dayName(d.day), value: pick(d) }));
  const moneyIn = t.days.reduce((n, d) => n + d.moneyInPaise, 0);
  const revenue = t.days.reduce((n, d) => n + d.revenuePaise, 0);
  const plays = t.days.reduce((n, d) => n + d.plays, 0);
  return (
    <section className="stack" aria-labelledby="days-charts">
      <h2 id="days-charts" style={{ margin: 0 }}>
        Last {t.days.length} days
      </h2>
      <div className="rc-chart-grid">
        <div className="rc-chart-card">
          <BarChart
            title="Money in, day by day"
            summary={`${rupees(moneyIn)} paid by brands, with GST`}
            points={days((d) => d.moneyInPaise)}
            format={rupees}
            axisFormat={rupeesShort}
            valueName="Money in"
            empty="No money in these days."
          />
        </div>
        <div className="rc-chart-card">
          <LineChart
            area
            title="Revenue earned, day by day"
            summary={`${rupees(revenue)} earned as plays were delivered (before GST)`}
            points={days((d) => d.revenuePaise)}
            format={rupees}
            axisFormat={rupeesShort}
            valueName="Revenue"
            empty="No revenue earned these days."
          />
        </div>
        <div className="rc-chart-card">
          <BarChart
            title="Brand ads played, day by day"
            summary={`${count(plays)} in all`}
            points={days((d) => d.plays)}
            format={count}
            valueName="Plays"
            empty="No ads played these days."
          />
        </div>
      </div>
    </section>
  );
}

/** Bike-hours sold each month, against the bike-hours the screens were out. */
function MonthsChart({ months }: { months: readonly MonthNumbers[] }) {
  const now = months.at(-1);
  return (
    <section className="rc-chart-card" aria-label="Bike-hours by month">
      <BarChart
        title="Bike-hours sold each month"
        summary={
          now
            ? `${count(now.soldBikeHours)} sold in ${monthName(now.month)} · screens out ${count(now.screenBikeHours)} bike-hours`
            : undefined
        }
        points={months.map((m) => ({
          label: monthLabel(m.month),
          full: monthName(m.month),
          value: m.soldBikeHours,
          target: m.screenBikeHours,
        }))}
        format={count}
        valueName="Sold"
        targetName="Screens out"
        height={180}
        empty="Nothing sold in these months."
      />
    </section>
  );
}
