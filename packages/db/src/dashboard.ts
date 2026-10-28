// P3.14.2: the business at a glance, month by month (India time), for the founder and sales. Read
// only. Bike-hours sold, bike-hours the screens were out and moving, how full that screen time was,
// money received and revenue earned, and refunds. Billing is by bike-hours only (hard rule 7).
import type { PoolClient } from 'pg';
import { indiaMonth } from './money.js';

type Q = Pick<PoolClient, 'query'>;

export interface MonthNumbers {
  readonly month: string;
  /** Bookings paid in the month (when the money came). */
  readonly bookingsPaid: number;
  /** Bike-hours sold for the month's days (paid bookings, not cancelled). */
  readonly soldBikeHours: number;
  /** Bike-hours the screens were on, and of those, moving (from the screens' minute summaries). */
  readonly screenBikeHours: number;
  readonly movingBikeHours: number;
  /**
   * How full the screen time was: bike-hours sold for days already over, as a share of the
   * screens' on-time, in basis points (null: no screen time yet).
   */
  readonly fillBp: number | null;
  /** Money brands paid in the month, GST included. */
  readonly moneyInPaise: number;
  /** Revenue earned as plays were delivered (before GST). */
  readonly revenuePaise: number;
  /** Refunds approved in the month: how many, how much (before GST), and as a share of revenue. */
  readonly refunds: number;
  readonly refundsPaise: number;
  readonly refundsBp: number | null;
}

const share = (part: number, whole: number) =>
  whole > 0 ? Math.floor((part * 10_000) / whole) : null;

/** One month's numbers. */
async function monthNumbers(c: Q, month: string, now: number): Promise<MonthNumbers> {
  const { from, to } = indiaMonth(month);
  const first = `${month}-01`;
  const next = new Date((to + 330 * 60) * 1000).toISOString().slice(0, 10);
  // The India business day now (02:00–08:00 still counts as the day before).
  const today = new Date((now + 330 * 60 - 2 * 3600) * 1000).toISOString().slice(0, 10);
  const [sold, screens, money, paid] = await Promise.all([
    c.query<{ bike_hours: string; past: string }>(
      `SELECT coalesce(sum(bl.bikes), 0) AS bike_hours,
              coalesce(sum(bl.bikes) FILTER (WHERE bl.day < $3::date), 0) AS past
         FROM booking_lines bl
        WHERE bl.day >= $1::date AND bl.day < $2::date
          AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = bl.booking_id
                       AND e.state = 'paid')
          AND (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                ORDER BY seq DESC LIMIT 1) <> 'cancelled'`,
      [first, next, today],
    ),
    c.query<{ clock: string; moving: string }>(
      `SELECT coalesce(sum(clock_s), 0) AS clock, coalesce(sum(moving_s), 0) AS moving
         FROM minute_summaries WHERE minute >= to_timestamp($1) AND minute < to_timestamp($2)`,
      [from, to],
    ),
    c.query<{ money_in: string; revenue: string; refunds: string; refunds_paise: string }>(
      `SELECT
         coalesce(sum(p.debit) FILTER (WHERE e.kind = 'booking-paid'
                                         AND p.account = 'payment-clearing'), 0) AS money_in,
         coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'revenue'), 0) AS revenue,
         count(DISTINCT e.entry_id) FILTER (WHERE e.kind = 'refund-approved') AS refunds,
         coalesce(sum(p.debit) FILTER (WHERE e.kind = 'refund-approved'
                                         AND p.account = 'campaign-held'), 0) AS refunds_paise
         FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
        WHERE e.at >= to_timestamp($1) AND e.at < to_timestamp($2)`,
      [from, to],
    ),
    c.query<{ n: string }>(
      `SELECT count(DISTINCT booking_id) AS n FROM booking_events
        WHERE state = 'paid' AND at >= to_timestamp($1) AND at < to_timestamp($2)`,
      [from, to],
    ),
  ]);
  const soldBikeHours = Number(sold.rows[0]?.bike_hours ?? 0);
  const screenBikeHours = Math.floor(Number(screens.rows[0]?.clock ?? 0) / 3600);
  const revenuePaise = Number(money.rows[0]?.revenue ?? 0);
  const refundsPaise = Number(money.rows[0]?.refunds_paise ?? 0);
  return {
    month,
    bookingsPaid: Number(paid.rows[0]?.n ?? 0),
    soldBikeHours,
    screenBikeHours,
    movingBikeHours: Math.floor(Number(screens.rows[0]?.moving ?? 0) / 3600),
    fillBp: share(Number(sold.rows[0]?.past ?? 0), screenBikeHours),
    moneyInPaise: Number(money.rows[0]?.money_in ?? 0),
    revenuePaise,
    refunds: Number(money.rows[0]?.refunds ?? 0),
    refundsPaise,
    refundsBp: share(refundsPaise, revenuePaise),
  };
}

/** The months ending with `last` ("YYYY-MM"), oldest first: at most 24. */
export async function businessDashboard(
  c: Q,
  last: string,
  now: number,
  count = 6,
): Promise<MonthNumbers[]> {
  indiaMonth(last);
  const n = Math.max(1, Math.min(24, Math.floor(count)));
  const [y, m] = last.split('-').map(Number) as [number, number];
  const months = Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
  const out: MonthNumbers[] = [];
  for (const month of months) out.push(await monthNumbers(c, month, now));
  return out;
}

// P7.7.7: the dashboard's charts. Today hour by hour (08:00–02:00 India time) and the last days,
// by business day: a day runs 02:00 to 02:00 India time, so 23:00–02:00 belongs to the day it
// started (hard rule 5). Read only. Plays are the screens' own signed plays as stored (hard rule
// 1), brand ads and make-ups only; whether each counts for a booking is decided elsewhere.

const IST_S = 330 * 60;
/** The first hour of the business day and how many hours it has (08:00 to 02:00). */
const FIRST_HOUR = 8;
const HOURS = 18;

export interface HourTrend {
  /** India hour the hour starts at: 8 … 23, then 24 and 25 for midnight and 1am. */
  readonly hour: number;
  /** Its start, UTC seconds. */
  readonly at: number;
  /** Brand ads (and make-ups) the screens played in the hour. */
  readonly plays: number;
  /** Different screens that were on in the hour. */
  readonly screens: number;
}

export interface DayTrend {
  /** The business day, "YYYY-MM-DD". */
  readonly day: string;
  readonly plays: number;
  /** Bike-hours the screens were on (whole hours, rounded down). */
  readonly screenBikeHours: number;
  /** Money brands paid, GST included, and revenue earned as plays were delivered. */
  readonly moneyInPaise: number;
  readonly revenuePaise: number;
}

export interface BusinessTrends {
  /** Today's business day. */
  readonly day: string;
  readonly hours: readonly HourTrend[];
  /** The last `days` business days, oldest first, today last; days with nothing are 0. */
  readonly days: readonly DayTrend[];
}

/** The business day ("YYYY-MM-DD") of a UTC time; 02:00–08:00 (no ads) falls on the new date. */
const trendDay = (t: number): string =>
  new Date((t + IST_S - 2 * 3600) * 1000).toISOString().slice(0, 10);

/** UTC seconds of hh:00 India time on a date. */
const indiaAt = (day: string, hour: number) =>
  Date.parse(`${day}T00:00:00Z`) / 1000 - IST_S + hour * 3600;

const dayBefore = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const DAY_SQL = (col: string) =>
  `((${col} AT TIME ZONE 'Asia/Kolkata') - interval '2 hours')::date`;

export async function businessTrends(c: Q, now: number, days = 30): Promise<BusinessTrends> {
  const n = Math.max(1, Math.min(90, Math.floor(days)));
  const day = trendDay(now);
  const start = indiaAt(day, FIRST_HOUR);
  const first = dayBefore(day, n - 1);
  const from = indiaAt(first, 2);
  const until = indiaAt(day, 26);
  const [plays, screens, playDays, screenDays, money] = await Promise.all([
    c.query<{ h: number; n: string }>(
      `SELECT floor((extract(epoch FROM start_at) - $1) / 3600)::int AS h, count(*) AS n
         FROM plays
        WHERE start_at >= to_timestamp($1) AND start_at < to_timestamp($2)
          AND slot IN ('brand', 'make-up')
        GROUP BY 1`,
      [start, start + HOURS * 3600],
    ),
    c.query<{ h: number; n: string }>(
      `SELECT floor((extract(epoch FROM minute) - $1) / 3600)::int AS h,
              count(DISTINCT screen_id) AS n
         FROM minute_summaries
        WHERE minute >= to_timestamp($1) AND minute < to_timestamp($2) AND clock_s > 0
        GROUP BY 1`,
      [start, start + HOURS * 3600],
    ),
    c.query<{ day: string; n: string }>(
      `SELECT ${DAY_SQL('start_at')}::text AS day, count(*) AS n
         FROM plays
        WHERE start_at >= to_timestamp($1) AND start_at < to_timestamp($2)
          AND slot IN ('brand', 'make-up')
        GROUP BY 1`,
      [from, until],
    ),
    c.query<{ day: string; clock: string }>(
      `SELECT ${DAY_SQL('minute')}::text AS day, sum(clock_s) AS clock
         FROM minute_summaries
        WHERE minute >= to_timestamp($1) AND minute < to_timestamp($2)
        GROUP BY 1`,
      [from, until],
    ),
    c.query<{ day: string; money_in: string; revenue: string }>(
      `SELECT ${DAY_SQL('e.at')}::text AS day,
              coalesce(sum(p.debit) FILTER (WHERE e.kind = 'booking-paid'
                                              AND p.account = 'payment-clearing'), 0) AS money_in,
              coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'revenue'), 0) AS revenue
         FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
        WHERE e.at >= to_timestamp($1) AND e.at < to_timestamp($2)
        GROUP BY 1`,
      [from, until],
    ),
  ]);
  const byHour = (rows: readonly { h: number; n: string }[]) =>
    new Map(rows.map((r) => [Number(r.h), Number(r.n)]));
  const playsAt = byHour(plays.rows);
  const screensAt = byHour(screens.rows);
  const playsOn = new Map(playDays.rows.map((r) => [r.day, Number(r.n)]));
  const clockOn = new Map(screenDays.rows.map((r) => [r.day, Number(r.clock)]));
  const moneyOn = new Map(money.rows.map((r) => [r.day, r]));
  return {
    day,
    hours: Array.from({ length: HOURS }, (_, i) => ({
      hour: FIRST_HOUR + i,
      at: start + i * 3600,
      plays: playsAt.get(i) ?? 0,
      screens: screensAt.get(i) ?? 0,
    })),
    days: Array.from({ length: n }, (_, i) => {
      const d = dayBefore(day, n - 1 - i);
      const m = moneyOn.get(d);
      return {
        day: d,
        plays: playsOn.get(d) ?? 0,
        screenBikeHours: Math.floor((clockOn.get(d) ?? 0) / 3600),
        moneyInPaise: Number(m?.money_in ?? 0),
        revenuePaise: Number(m?.revenue ?? 0),
      };
    }),
  };
}
