// P1.7.5–6 in the database: who rides which screen, each rider's POC base, and the monthly pay run
// that keeps every rider's pay for a month in the ledger (rider earnings, owed less TDS).
import {
  dailyTotals,
  DEFAULT_MOVING_HOUR_RULES,
  isoAt,
  lineIdOf,
  monthlyHours,
  priceBookAt,
  riderPay,
  riderPayAccrued,
  soldShares,
  type PriceBook,
  type RiderPay,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { postEntry } from './ledger.js';
import { inTransaction, paidForLine, type OpenLine } from './makeups.js';
import { countedPlaysFor } from './plays.js';
import { minutesOf } from './screen-reports.js';

const RIDER = /^[A-Za-z0-9-]{3,40}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Puts a rider on a screen from a moment (or takes the screen off its rider: `riderId` null). */
export async function assignScreen(
  pool: Pool,
  screenId: string,
  riderId: string | null,
  from: number,
  by: string,
): Promise<void> {
  if (riderId !== null && !RIDER.test(riderId)) throw new RangeError(`Bad rider id ${riderId}`);
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-screens'))");
    // One screen per rider at a time: his hours and plays must come from one bike.
    if (riderId !== null) {
      const other = await c.query<{ screen_id: string }>(
        `SELECT screen_id FROM (
           SELECT DISTINCT ON (screen_id) screen_id, rider_id FROM rider_screens
            WHERE from_at <= to_timestamp($2) ORDER BY screen_id, from_at DESC) x
          WHERE rider_id = $1 AND screen_id <> $3`,
        [riderId, from, screenId],
      );
      const busy = other.rows[0];
      if (busy) throw new Error(`${riderId} is on ${busy.screen_id}: take him off it first`);
    }
    await c.query(
      `INSERT INTO rider_screens (screen_id, from_at, rider_id, set_by)
       VALUES ($1, to_timestamp($2), $3, $4)`,
      [screenId, from, riderId, by],
    );
  });
}

/** Puts a rider on a POC base from a month on (a base of that month's price book, or 0 to end it). */
export async function setPocBase(
  pool: Pool,
  riderId: string,
  fromMonth: string,
  basePaise: number,
  by: { readonly id: string; readonly role: string },
  reason: string,
): Promise<void> {
  if (by.role !== 'super-admin' && by.role !== 'admin')
    throw new Error('Only an admin can set a rider’s base');
  if (!RIDER.test(riderId)) throw new RangeError(`Bad rider id ${riderId}`);
  if (!MONTH.test(fromMonth)) throw new RangeError('Month must be YYYY-MM');
  await inTransaction(pool, async (c) => {
    // The bases of the price book for that month; 0 takes a rider off his base.
    const book = priceBookAt(await priceBooks(c), isoAt(monthBounds(fromMonth).start));
    if (basePaise !== 0 && !book?.riderPay.pocBasesPaise.includes(basePaise))
      throw new RangeError(
        `Base must be 0 or one of ${(book?.riderPay.pocBasesPaise ?? []).map((p) => `₹${p / 100}`).join(', ')}`,
      );
    await c.query(
      `INSERT INTO rider_poc_bases (rider_id, from_month, base_paise, set_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [riderId, fromMonth, basePaise, by.id, reason],
    );
  });
}

/** UTC seconds: when a month's business days start, and when the last one ends (02:00 India). */
export function monthBounds(month: string): { start: number; end: number } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const ist = 330 * 60;
  return {
    start: Date.UTC(y, m - 1, 1) / 1000 - ist + 8 * 3600,
    end: Date.UTC(y, m, 1) / 1000 - ist + 2 * 3600,
  };
}

/** Each stretch of time a rider rode a screen, overlapping [from, to). */
async function stretches(c: Pick<PoolClient, 'query'>, from: number, to: number) {
  const r = await c.query<{ screen_id: string; rider_id: string; a: string; b: string | null }>(
    `SELECT screen_id, rider_id, extract(epoch FROM from_at)::bigint AS a,
            extract(epoch FROM next_at)::bigint AS b
       FROM (SELECT screen_id, rider_id, from_at,
                    lead(from_at) OVER (PARTITION BY screen_id ORDER BY from_at) AS next_at
               FROM rider_screens) s
      WHERE rider_id IS NOT NULL AND from_at < to_timestamp($2)
        AND (next_at IS NULL OR next_at > to_timestamp($1))
      ORDER BY screen_id, from_at`,
    [from, to],
  );
  return r.rows.map((x) => ({
    screenId: x.screen_id,
    riderId: x.rider_id,
    from: Number(x.a),
    to: x.b === null ? Number.POSITIVE_INFINITY : Number(x.b),
  }));
}
type Stretch = Awaited<ReturnType<typeof stretches>>[number];

/** Who rode a screen at a moment: stretches grouped by screen, so each lookup is short. */
function ridersOf(all: readonly Stretch[]) {
  const byScreen = new Map<string, Stretch[]>();
  for (const s of all) byScreen.set(s.screenId, [...(byScreen.get(s.screenId) ?? []), s]);
  return (screenId: string, t: number) =>
    byScreen.get(screenId)?.find((s) => s.from <= t && t < s.to)?.riderId;
}

/**
 * What each rider's counted plays sold in a month: every sold line of the month's business days
 * (with its make-ups) is shared between the screens that delivered its counted plays, and each
 * play goes to the rider riding that screen when it played. Money kept without delivery sells
 * nothing for a rider.
 */
async function soldByRider(
  c: PoolClient,
  month: string,
  all: readonly Stretch[],
  books: readonly PriceBook[],
): Promise<Map<string, number>> {
  const lines = await c.query<OpenLine>(
    `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
            b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise, b.price_book_version
       FROM booking_lines bl JOIN bookings b USING (booking_id)
      WHERE to_char(bl.day, 'YYYY-MM') = $1 AND NOT b.trial
        AND EXISTS (SELECT 1 FROM booking_events p WHERE p.booking_id = bl.booking_id AND p.state = 'paid')
      ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
    [month],
  );
  const out = new Map<string, number>();
  const riderAt = ridersOf(all);
  for (const l of lines.rows) {
    const book = books.find((b) => b.version === l.price_book_version);
    if (!book) throw new Error(`price book ${l.price_book_version} not found`);
    const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
    const counted = [
      ...(await countedPlaysFor(c, lineId, books)),
      ...(await countedPlaysFor(c, `${lineId}#1`, books)),
      ...(await countedPlaysFor(c, `${lineId}#2`, books)),
    ];
    if (counted.length === 0) continue;
    // A play by a screen nobody was riding sells for no rider ('').
    const keys = counted.map((p) => riderAt(p.screenId, p.startAt) ?? '');
    for (const [rider, paise] of soldShares(await paidForLine(c, l, book), l.plays, keys))
      if (rider !== '') out.set(rider, (out.get(rider) ?? 0) + paise);
  }
  return out;
}

/** A rider's moving seconds in a month, from the screens he rode while he rode them. */
async function hoursOf(
  c: PoolClient,
  riderId: string,
  month: string,
  all: readonly Stretch[],
  capHours: number,
) {
  const { start, end } = monthBounds(month);
  const minutes = [];
  for (const s of all.filter((x) => x.riderId === riderId)) {
    const from = Math.max(s.from, start - 3600);
    const to = Math.min(s.to, end + 3600);
    // Minutes are counted by the screen's minute start: a minute belongs to whoever rode at its start.
    for (const m of await minutesOf(c, s.screenId, from, to))
      if (m.minute >= s.from && m.minute < s.to) minutes.push(m);
  }
  const days = new Map([...dailyTotals(minutes)].filter(([day]) => day.startsWith(month)));
  const [m] = monthlyHours(days, { ...DEFAULT_MOVING_HOUR_RULES, monthlyCapHours: capHours });
  return { countedSeconds: m?.countedSeconds ?? 0, paidSeconds: m?.paidSeconds ?? 0 };
}

export interface RiderMonthPay extends RiderPay {
  readonly riderId: string;
  readonly countedSeconds: number;
  readonly paidSeconds: number;
  readonly soldPaise: number;
  readonly final: boolean;
}

/**
 * Brings every rider's pay for `month` in the ledger up to date at `now` (P1.7.5–6): POC pay once
 * the month has ended; after the POC, as the month goes (for the Monday payouts). Once the month
 * has closed (`monthCloseHours` after its end) it never changes by itself: late changes are
 * reported in `late`. Safe to run as often as wanted: runs take turns and each posts only what changed.
 * One rider failing does not hold up the others.
 */
export async function accrueRiderPay(
  pool: Pool,
  month: string,
  now: number,
): Promise<{
  pay: RiderMonthPay[];
  posted: number;
  failed: { riderId: string; error: string }[];
  /** Changes found after the month closed: not posted, for finance to settle by hand. */
  late: { riderId: string; grossChange: number }[];
}> {
  if (!MONTH.test(month)) throw new RangeError('Month must be YYYY-MM');
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-pay'))");
    const books = await priceBooks(c);
    const { start, end } = monthBounds(month);
    // The rules in force when the month starts.
    const book = priceBookAt(books, isoAt(start));
    if (!book) throw new Error(`No price book in force for ${month}`);
    const rules = book.riderPay;
    const ended = now >= end;
    const final = now >= end + rules.monthCloseHours * 3600;
    // Up to two days after the month: a last-day line's make-up plays the next day (to 02:00).
    const all = await stretches(c, start - 3600, end + 2 * 86_400);
    const sold: Map<string, number> =
      rules.mode === 'standard' ? await soldByRider(c, month, all, books) : new Map();
    const bases = await c.query<{ rider_id: string; base: string }>(
      `SELECT DISTINCT ON (rider_id) rider_id, base_paise AS base FROM rider_poc_bases
        WHERE from_month <= $1 ORDER BY rider_id, from_month DESC`,
      [month],
    );
    const baseOf = new Map(bases.rows.map((r) => [r.rider_id, Number(r.base)]));
    // Riders who rode a screen during the month, or whose plays sold for it (a last-day line's
    // make-up plays the next day). A base alone pays nothing.
    const riders = [
      ...new Set([
        ...all.filter((s) => s.from < end && s.to > start).map((s) => s.riderId),
        ...sold.keys(),
      ]),
    ].sort();
    const pay: RiderMonthPay[] = [];
    const failed: { riderId: string; error: string }[] = [];
    const late: { riderId: string; grossChange: number }[] = [];
    let posted = 0;
    for (const riderId of riders) {
      await c.query('SAVEPOINT rider');
      try {
        const h = await hoursOf(c, riderId, month, all, rules.monthlyCapHours);
        const soldPaise = sold.get(riderId) ?? 0;
        const p = riderPay(rules, { ...h, soldPaise, pocBasePaise: baseOf.get(riderId) }, ended);
        const so = await c.query<{ gross: string; tds: string; n: string }>(
          `SELECT coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = 'rider-earnings'), 0) AS gross,
                  coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'), 0) AS tds,
                  count(DISTINCT e.entry_id) AS n
             FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
            WHERE e.ref = $1 AND e.kind = 'rider-pay'`,
          [`${riderId}/${month}`],
        );
        const row = so.rows[0];
        const e = riderPayAccrued(
          riderId,
          month,
          p,
          { gross: Number(row?.gross ?? 0), tds: Number(row?.tds ?? 0) },
          Number(row?.n ?? 0) + 1,
          now,
        );
        // A closed month never changes by itself (its pay may be paid out): a late change is
        // reported for finance to settle by hand.
        if (e && !final) {
          await postEntry(c, e, 'rider-pay');
          posted += 1;
        } else if (e) late.push({ riderId, grossChange: p.gross - Number(row?.gross ?? 0) });
        pay.push({ ...p, ...h, riderId, soldPaise, final });
        await c.query('RELEASE SAVEPOINT rider');
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT rider');
        failed.push({ riderId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { pay, posted, failed, late };
  });
}
