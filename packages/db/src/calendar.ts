// P3.7 in the database: one area's week on the inventory calendar, and the holds Sales keeps for
// clients (placed in bookings.ts; released early and listed here).
import {
  areaHourKey,
  CALENDAR_HOURS,
  calendarDays,
  cellOf,
  isoAt,
  lineIdOf,
  priceBookAt,
  usualBikes,
  type BookingLine,
  type CalendarCell,
  type DeliveredLine,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inventoryFor, lockInventory, priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';
import { lineTotalsFor } from './plays.js';
import { Refusal } from './refusal.js';
import { supplyHistory } from './supply.js';

export interface HoldView {
  readonly holdId: string;
  readonly brandId: string;
  readonly heldBy: string;
  readonly reason: string | null;
  readonly createdAt: number;
  /** When it stops keeping bikes: its set end, or when it was released. */
  readonly until: number;
  readonly endedEarly: { at: number; by: string; reason: string } | null;
  /** A booking made from it that is not a draft or cancelled, if any. */
  readonly bookingId: string | null;
  readonly lines: readonly { date: string; startHour: number; bikes: number }[];
}

export interface CalendarWeek {
  readonly areaId: string;
  readonly days: readonly string[];
  readonly mode: 'poc' | 'forecast';
  readonly cells: readonly CalendarCell[];
  readonly holds: readonly HoldView[];
}

/** Holds with lines in this area on these days (live or not), newest first. */
export async function holdsIn(
  pool: Pick<Pool, 'query'>,
  areaId: string,
  days: readonly string[],
): Promise<HoldView[]> {
  const r = await pool.query<{
    hold_id: string;
    brand_id: string;
    held_by: string;
    reason: string | null;
    created_at: Date;
    until: Date;
    ended_at: Date | null;
    ended_by: string | null;
    end_reason: string | null;
    booking_id: string | null;
    lines: { date: string; startHour: number; bikes: number }[];
  }>(
    `SELECT h.hold_id, h.brand_id, h.held_by, h.reason, h.created_at, h.until,
            he.ended_at, he.ended_by, he.reason AS end_reason,
            (SELECT b.booking_id FROM bookings b
               JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                              ORDER BY seq DESC LIMIT 1) s ON true
              WHERE b.hold_id = h.hold_id AND s.state NOT IN ('draft', 'cancelled', 'ads-missing')
              ORDER BY b.created_at LIMIT 1) AS booking_id,
            (SELECT json_agg(json_build_object('date', hl.day::text, 'startHour', hl.start_hour,
                                               'bikes', hl.bikes) ORDER BY hl.day, hl.start_hour)
               FROM hold_lines hl WHERE hl.hold_id = h.hold_id) AS lines
       FROM holds h LEFT JOIN hold_ends he USING (hold_id)
      WHERE EXISTS (SELECT 1 FROM hold_lines hl WHERE hl.hold_id = h.hold_id
                       AND hl.area_id = $1 AND hl.day = ANY($2::date[]))
      ORDER BY h.created_at DESC, h.hold_id`,
    [areaId, days],
  );
  const secs = (d: Date) => Math.floor(d.getTime() / 1000);
  return r.rows.map((h) => ({
    holdId: h.hold_id,
    brandId: h.brand_id,
    heldBy: h.held_by,
    reason: h.reason,
    createdAt: secs(h.created_at),
    until: h.ended_at && h.ended_at < h.until ? secs(h.ended_at) : secs(h.until),
    endedEarly:
      h.ended_at && h.ended_by && h.end_reason
        ? { at: secs(h.ended_at), by: h.ended_by, reason: h.end_reason }
        : null,
    bookingId: h.booking_id,
    lines: h.lines,
  }));
}

/** One area's week: every start hour of `days` days from `from`. */
export async function calendarWeek(
  pool: Pool,
  areaId: string,
  from: string,
  now: number,
  dayCount = 7,
): Promise<CalendarWeek> {
  const days = calendarDays(from, dayCount);
  const slots: BookingLine[] = days.flatMap((date) =>
    CALENDAR_HOURS.map((startHour) => ({ areaId, date, startHour, bikes: 0 })),
  );
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  const c = pool as unknown as PoolClient;
  const inv = await inventoryFor(c, slots, now);
  const manual = await pool.query<{ day: string; start_hour: number; max_bikes: number | null }>(
    `SELECT DISTINCT ON (day, start_hour) day::text, start_hour, max_bikes FROM area_hour_limits
      WHERE area_id = $1 AND day = ANY($2::date[]) ORDER BY day, start_hour, version DESC`,
    [areaId, days],
  );
  const manualOf = new Map(
    manual.rows.map((r) => [`${areaId}|${r.day}|${r.start_hour}`, r.max_bikes]),
  );
  const held = new Map<string, number>();
  for (const h of inv.holds)
    for (const l of h.lines) held.set(areaHourKey(l), (held.get(areaHourKey(l)) ?? 0) + l.bikes);
  const history = book ? await supplyHistory(c, slots, book.capacity, now) : new Map();

  // Paid, not cancelled lines (trials included: they run on real bikes) in hours already over.
  const paid = await pool.query<{
    booking_id: string;
    day: string;
    start_hour: number;
    bikes: number;
    plays: number;
  }>(
    `SELECT bl.booking_id, bl.day::text AS day, bl.start_hour, bl.bikes, bl.plays
       FROM booking_lines bl
      WHERE bl.area_id = $1 AND bl.day = ANY($2::date[])
        AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = bl.booking_id AND e.state = 'paid')
        AND (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
              ORDER BY seq DESC LIMIT 1) <> 'cancelled'`,
    [areaId, days],
  );
  const books = paid.rows.length > 0 ? await priceBooks(pool) : [];
  const delivered = new Map<string, DeliveredLine[]>();
  for (const l of paid.rows) {
    const k = `${areaId}|${l.day}|${l.start_hour}`;
    const lineId = lineIdOf(l.booking_id, areaId, l.day, l.start_hour);
    const counted = (await lineTotalsFor(pool, lineId, books)).plays;
    delivered.set(k, [...(delivered.get(k) ?? []), { bikes: l.bikes, plays: l.plays, counted }]);
  }

  const cells = slots.map((s) => {
    const k = areaHourKey(s);
    const manualLimit = manualOf.get(k) ?? null;
    const h = history.get(k);
    return cellOf({
      date: s.date,
      startHour: s.startHour,
      booked: inv.sold.get(k) ?? 0,
      held: held.get(k) ?? 0,
      manualLimit,
      // inventoryFor already folds the forecast in after the POC where no manual limit is set.
      forecast: manualLimit === null ? (inv.limits.get(k) ?? null) : null,
      usual: h && book ? usualBikes(h.weeks, book.capacity) : null,
      delivered: delivered.get(k) ?? [],
      now,
    });
  });
  return {
    areaId,
    days,
    mode: book?.capacity.mode ?? 'poc',
    cells,
    holds: await holdsIn(pool, areaId, days),
  };
}

/** Releases a hold before its set end: its bikes go back on sale at once. With who and why. */
export async function endHold(
  pool: Pool,
  holdId: string,
  by: string,
  reason: string,
  now: number,
): Promise<void> {
  if (reason.trim().length < 3) throw new Refusal('Give a reason (3 to 200 characters)');
  await inTransaction(pool, async (c) => {
    await lockInventory(c);
    const r = await c.query<{ until: Date; ended: boolean }>(
      `SELECT h.until, EXISTS (SELECT 1 FROM hold_ends he WHERE he.hold_id = h.hold_id) AS ended
         FROM holds h WHERE h.hold_id = $1`,
      [holdId],
    );
    const h = r.rows[0];
    if (!h) throw new Refusal(`No hold ${holdId}`);
    if (h.ended) throw new Refusal('This hold was already released');
    if (h.until.getTime() / 1000 <= now) throw new Refusal('This hold has already ended');
    await c.query(
      'INSERT INTO hold_ends (hold_id, ended_at, ended_by, reason) VALUES ($1, to_timestamp($2), $3, $4)',
      [holdId, now, by, reason.trim().slice(0, 200)],
    );
  });
}
