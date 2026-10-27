// P1.7.5–6 in the database: who rides which screen, and the monthly pay run
// that keeps every rider's pay for a month in the ledger (rider earnings, owed less TDS).
import {
  dailyTotals,
  DEFAULT_MOVING_HOUR_RULES,
  isoAt,
  lineIdOf,
  monthlyHours,
  pocBonusEntry,
  pocMonthBonus,
  pocEndedAt,
  pocFirstMonth,
  pocMonthOf,
  modeAt,
  toIndiaTime,
  priceBookAt,
  riderPay,
  riderPayAccrued,
  soldShares,
  type PriceBook,
  type RiderPay,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { businessModes } from './business-mode.js';
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
  await inTransaction(pool, async (c) => {
    // An enrolled screen (P2.1) moves only with its fitting, so fitting and pay never disagree.
    const enrolled = await c.query('SELECT 1 FROM screens WHERE screen_id = $1', [screenId]);
    if (enrolled.rowCount)
      throw new Error(`${screenId} is fitted by QR: use fitScreen or unfitScreen to move it`);
    await assignScreenIn(c, screenId, riderId, from, by);
  });
}

/** The same, inside a caller's transaction (fitting a screen, P2.1, does it with the fitting). */
export async function assignScreenIn(
  c: PoolClient,
  screenId: string,
  riderId: string | null,
  from: number,
  by: string,
): Promise<void> {
  if (riderId !== null && !RIDER.test(riderId)) throw new RangeError(`Bad rider id ${riderId}`);
  await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-screens'))");
  // One screen per rider at a time: their hours and plays must come from one bike.
  if (riderId !== null) {
    const other = await c.query<{ screen_id: string }>(
      `SELECT screen_id FROM (
         SELECT DISTINCT ON (screen_id) screen_id, rider_id FROM rider_screens
          WHERE from_at <= to_timestamp($2) ORDER BY screen_id, from_at DESC) x
        WHERE rider_id = $1 AND screen_id <> $3`,
      [riderId, from, screenId],
    );
    const busy = other.rows[0];
    if (busy) throw new Error(`${riderId} is on ${busy.screen_id}: take them off it first`);
  }
  await c.query(
    `INSERT INTO rider_screens (screen_id, from_at, rider_id, set_by)
     VALUES ($1, to_timestamp($2), $3, $4)`,
    [screenId, from, riderId, by],
  );
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
  /** Only plays at moments this keeps (under regular business). */
  keep: (t: number) => boolean,
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
    // A play by a screen nobody was riding, or under the POC, sells for no rider ('').
    const keys = counted.map((p) =>
      keep(p.startAt) ? (riderAt(p.screenId, p.startAt) ?? '') : '',
    );
    for (const [rider, paise] of soldShares(await paidForLine(c, l, book), l.plays, keys))
      if (rider !== '') out.set(rider, (out.get(rider) ?? 0) + paise);
  }
  return out;
}

/** A rider's moving seconds in a month, from the screens he rode while he rode them. */
async function hoursOf(
  c: Pick<PoolClient, 'query'>,
  riderId: string,
  month: string,
  all: readonly Stretch[],
  capHours: number,
  /** Only minutes starting at moments this keeps (e.g. under one business mode). */
  keep: (t: number) => boolean,
) {
  const { start, end } = monthBounds(month);
  const minutes = [];
  for (const s of all.filter((x) => x.riderId === riderId)) {
    const from = Math.max(s.from, start - 3600);
    const to = Math.min(s.to, end + 3600);
    // Minutes are counted by the screen's minute start: a minute belongs to whoever rode at its start.
    for (const m of await minutesOf(c, s.screenId, from, to))
      if (m.minute >= s.from && m.minute < s.to && keep(m.minute)) minutes.push(m);
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
  /** POC: days of the month he held a screen (of those ended). */
  readonly pocDays: readonly number[];
  readonly final: boolean;
}

/** The days of a month (1…31) that have ended by `now`, with their business-day windows. */
function daysOf(month: string, now: number) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ist = 330 * 60;
  const days = Array.from({ length: count }, (_, i) => {
    const from = Date.UTC(y, m - 1, i + 1) / 1000 - ist + 8 * 3600;
    return { day: i + 1, from, to: from + 18 * 3600 };
  });
  return { count, ended: days.filter((d) => now >= d.to) };
}

/** The rules for a month: the price book in force when the month starts. */
function rulesFor(books: readonly PriceBook[], month: string) {
  const book = priceBookAt(books, isoAt(monthBounds(month).start));
  if (!book) throw new Error(`No price book in force for ${month}`);
  return book.riderPay;
}

/**
 * Brings every rider's pay for `month` in the ledger up to date at `now` (P1.7.5–6), for the
 * Monday payouts. A POC month: the month's pay (₹8,000 / ₹10,000 / ₹12,000) for each day he held a
 * screen, as the days end. After the POC: ₹25 a moving hour + 25% of what his plays sold, as they
 * come in. Once the month has closed (`monthCloseHours` after its end) it never changes by itself:
 * late changes are reported in `late`. Safe to run as often as wanted: runs take turns and each
 * posts only what changed. One rider failing does not hold up the others.
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
    const rules = rulesFor(books, month);
    const { start, end } = monthBounds(month);
    const final = now >= end + rules.monthCloseHours * 3600;
    const changes = await businessModes(c);
    const isPoc = (t: number) => modeAt(changes, t) === 'poc';
    const isRegular = (t: number) => !isPoc(t);
    const pocMonth = pocMonthOf(pocFirstMonth(changes), month);
    const days = daysOf(month, now);
    // Up to two days after the month: a last-day line's make-up plays the next day (to 02:00).
    const all = await stretches(c, start - 3600, end + 2 * 86_400);
    const anyRegular = isRegular(start) || changes.some((x) => x.from > start && x.from < end);
    const sold: Map<string, number> = anyRegular
      ? await soldByRider(c, month, all, books, isRegular)
      : new Map();
    // Riders who rode a screen during the month, or whose plays sold for it (a last-day line's
    // make-up plays the next day).
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
        const h = await hoursOf(c, riderId, month, all, rules.monthlyCapHours, isRegular);
        const soldPaise = sold.get(riderId) ?? 0;
        const mine = all.filter((s) => s.riderId === riderId);
        // A POC day he held a screen (the mode at the start of the business day).
        const pocDays = days.ended
          .filter((d) => isPoc(d.from) && mine.some((s) => s.from < d.to && s.to > d.from))
          .map((d) => d.day);
        const p = riderPay(rules, pocMonth, { ...h, soldPaise, pocDays, daysInMonth: days.count });
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
          // Its parts, for the rider app's Earnings page (P4.5).
          await c.query(
            `INSERT INTO rider_pay_lines (entry_id, rider_id, month, at, counted_s, paid_s,
               poc_paise, hourly_paise, sold_paise, gross_paise, tds_paise)
             VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11)`,
            [
              e.entryId,
              riderId,
              month,
              now,
              h.countedSeconds,
              h.paidSeconds,
              p.poc,
              p.hourly,
              p.sold,
              p.gross,
              p.tds,
            ],
          );
          posted += 1;
        } else if (e) late.push({ riderId, grossChange: p.gross - Number(row?.gross ?? 0) });
        pay.push({ ...p, ...h, riderId, soldPaise, pocDays, final });
        await c.query('RELEASE SAVEPOINT rider');
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT rider');
        failed.push({ riderId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { pay, posted, failed, late };
  });
}

export interface PocBonusRow {
  readonly riderId: string;
  /** Verified moving hours under the POC in the month, as seconds (0 for the finishing bonus). */
  readonly countedSeconds: number;
  /** What the bonus comes to (0 when not earned). */
  readonly amountPaise: number;
  readonly given: boolean;
}

/**
 * A POC month's founding bonus for every rider who rode in it (P1.7.6): his verified moving hours
 * under the POC and the bonus they earn (full at 150+, in proportion from 100, none below), and
 * whether it was given. For the admin portal: a super admin gives each one (`givePocBonus`).
 */
export async function pocBonusList(
  c: Pick<PoolClient, 'query'>,
  month: string,
): Promise<PocBonusRow[]> {
  if (!MONTH.test(month)) throw new RangeError('Month must be YYYY-MM');
  const books = await priceBooks(c);
  const rules = rulesFor(books, month);
  const changes = await businessModes(c);
  const isPoc = (t: number) => modeAt(changes, t) === 'poc';
  const { start, end } = monthBounds(month);
  const pocInMonth =
    isPoc(start) || changes.some((x) => x.mode === 'poc' && x.from < end && x.from > start);
  if (!pocInMonth) throw new Error(`${month} is not a POC month`);
  const all = await stretches(c, start - 3600, end + 3600);
  const given = await c.query<{ ref: string }>(
    "SELECT ref FROM ledger_entries WHERE kind = 'poc-bonus' AND ref LIKE '%/' || $1",
    [month],
  );
  const done = new Set(given.rows.map((r) => r.ref));
  const out: PocBonusRow[] = [];
  const riders = all.filter((s) => s.from < end && s.to > start).map((s) => s.riderId);
  for (const riderId of [...new Set(riders)].sort()) {
    const { countedSeconds } = await hoursOf(c, riderId, month, all, rules.monthlyCapHours, isPoc);
    out.push({
      riderId,
      countedSeconds,
      amountPaise: pocMonthBonus(rules, countedSeconds),
      given: done.has(`${riderId}/${month}`),
    });
  }
  return out;
}

/**
 * Riders who finished the POC and kept the screen: holding one when the business left the POC (the
 * last POC day's rules: the day before it ended).
 */
export async function pocFinishList(c: Pick<PoolClient, 'query'>): Promise<PocBonusRow[]> {
  const changes = await businessModes(c);
  const ended = pocEndedAt(changes);
  if (ended === undefined) throw new Error('The POC has not ended');
  const rules = rulesFor(
    await priceBooks(c),
    toIndiaTime(new Date((ended - 86_400) * 1000)).date.slice(0, 7),
  );
  const all = await stretches(c, ended - 3600, ended);
  const given = await c.query<{ ref: string }>(
    "SELECT ref FROM ledger_entries WHERE kind = 'poc-finish-bonus'",
  );
  const done = new Set(given.rows.map((r) => r.ref));
  return [...new Set(all.filter((s) => s.from < ended && s.to > ended).map((s) => s.riderId))]
    .sort()
    .map((riderId) => ({
      riderId,
      countedSeconds: 0,
      amountPaise: rules.pocFinishBonusPaise,
      given: done.has(riderId),
    }));
}

/**
 * A super admin gives a rider a POC bonus, once: a month's founding bonus (`month`), after that
 * month has closed and only if he earned some; or (`month` undefined) the bonus for finishing the
 * POC and keeping the screen, once the POC has ended and closed.
 */
export async function givePocBonus(
  pool: Pool,
  riderId: string,
  month: string | undefined,
  by: { readonly id: string; readonly role: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can give a POC bonus');
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-pay'))");
    const rows = month === undefined ? await pocFinishList(c) : await pocBonusList(c, month);
    const changes = await businessModes(c);
    const closes = month === undefined ? (pocEndedAt(changes) ?? 0) : monthBounds(month).end;
    const books = await priceBooks(c);
    const rules = rulesFor(
      books,
      month ?? toIndiaTime(new Date((closes - 86_400) * 1000)).date.slice(0, 7),
    );
    if (now < closes + rules.monthCloseHours * 3600)
      throw new Error('A POC bonus is given once its month (or the POC) has ended and closed');
    const row = rows.find((r) => r.riderId === riderId);
    if (!row)
      throw new Error(
        month === undefined
          ? `${riderId} did not keep a screen to the end of the POC`
          : `${riderId} did not ride in ${month}`,
      );
    if (row.given) throw new Error(`${riderId} already has this bonus`);
    if (row.amountPaise === 0)
      throw new Error(
        `${riderId} has ${Math.floor(row.countedSeconds / 3600)} moving hours in ${month ?? 'the POC'}; the bonus starts at ${rules.pocBonusFromHours}`,
      );
    await postEntry(c, pocBonusEntry(rules, riderId, row.amountPaise, month, now), by.id);
    return row.amountPaise;
  });
}
