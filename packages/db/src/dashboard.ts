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
