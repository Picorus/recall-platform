// P1.3 in the database: price books, bookings, their steps, holds, manual limits and free trials.
// The rules live in @recall/domain; this file stores and loads, and makes sure bookings and holds are
// checked one at a time so two people can never take the same limited bikes.
import {
  DEFAULT_CAPACITY_RULES,
  bookingPaid,
  DEFAULT_MAKE_UP_RULES,
  DEFAULT_PLAY_RULES,
  capacityProblems,
  checkPriceBook,
  isoAt,
  lineStartsAt,
  paise,
  priceBookAt,
  quote,
  stepProblem,
  timingOf,
  trialKeys,
  trialProblem,
  areaHourKey,
  type BookingLine,
  type BookingRequest,
  type Actor,
  type BookingState,
  type Business,
  type Hold,
  type PriceBook,
  type Quote,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { allAreaVersions } from './areas.js';
import { postEntry } from './ledger.js';
import { forecastLimits } from './supply.js';

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Bookings and holds are checked one at a time (inventory lock for this transaction). */
const lockInventory = (c: PoolClient) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['inventory']);

// ---------------------------------------------------------------- price books

export class PriceBookError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Price book cannot be saved: ${problems.join('; ')}`);
  }
}

/** Saves the next price book version (super admin only; the API checks who). */
export async function savePriceBook(pool: Pool, book: PriceBook, savedBy: string): Promise<void> {
  const problems = checkPriceBook(book);
  if (problems.length > 0) throw new PriceBookError(problems);
  await inTransaction(pool, (c) =>
    c.query(
      'INSERT INTO price_books (version, valid_from, book, saved_by) VALUES ($1, $2, $3, $4)',
      [book.version, book.validFrom, JSON.stringify(book), savedBy],
    ),
  );
}

export async function priceBooks(pool: Pick<Pool, 'query'>): Promise<PriceBook[]> {
  // Stored as saved; a book saved before a setting existed gets its default (the rule then).
  const r = await pool.query<{
    book: Partial<PriceBook> &
      Omit<PriceBook, 'capacity' | 'plays' | 'makeUps' | 'cancelRefundHours'>;
  }>('SELECT book FROM price_books ORDER BY version');
  return r.rows.map((x) => ({
    ...x.book,
    capacity: x.book.capacity ?? DEFAULT_CAPACITY_RULES,
    plays: x.book.plays ?? DEFAULT_PLAY_RULES,
    makeUps: x.book.makeUps ?? DEFAULT_MAKE_UP_RULES,
    cancelRefundHours: x.book.cancelRefundHours ?? 72,
  }));
}

// ---------------------------------------------------------------- inventory

export async function inventoryFor(c: PoolClient, lines: readonly BookingLine[], now: number) {
  const keys = [...new Set(lines.map(areaHourKey))];
  const areaIds = keys.map((k) => k.split('|')[0]);
  const days = keys.map((k) => k.split('|')[1]);
  const hours = keys.map((k) => Number(k.split('|')[2]));
  const wanted = `SELECT * FROM unnest($1::text[], $2::date[], $3::int[]) AS w(area_id, day, start_hour)`;
  const limits = await c.query<{
    area_id: string;
    day: string;
    start_hour: number;
    max_bikes: number | null;
  }>(
    `SELECT DISTINCT ON (l.area_id, l.day, l.start_hour) l.area_id, l.day::text, l.start_hour, l.max_bikes
       FROM area_hour_limits l JOIN (${wanted}) w USING (area_id, day, start_hour)
      ORDER BY l.area_id, l.day, l.start_hour, l.version DESC`,
    [areaIds, days, hours],
  );
  const sold = await c.query<{ area_id: string; day: string; start_hour: number; bikes: string }>(
    `SELECT bl.area_id, bl.day::text, bl.start_hour, sum(bl.bikes) AS bikes
       FROM booking_lines bl JOIN (${wanted}) w USING (area_id, day, start_hour)
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                      ORDER BY seq DESC LIMIT 1) s ON true
      WHERE s.state NOT IN ('draft', 'cancelled', 'ads-missing')
      GROUP BY bl.area_id, bl.day, bl.start_hour`,
    [areaIds, days, hours],
  );
  const holds = await c.query<{
    hold_id: string;
    until: Date;
    area_id: string;
    day: string;
    start_hour: number;
    bikes: number;
  }>(
    `SELECT h.hold_id, h.until, hl.area_id, hl.day::text, hl.start_hour, hl.bikes
       FROM holds h JOIN hold_lines hl USING (hold_id) JOIN (${wanted}) w USING (area_id, day, start_hour)
      WHERE h.until > to_timestamp($4)
        -- A hold that already became a live booking is counted as that booking, not twice.
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
            JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                           ORDER BY seq DESC LIMIT 1) s ON true
           WHERE b.hold_id = h.hold_id AND s.state NOT IN ('draft', 'cancelled', 'ads-missing'))`,
    [areaIds, days, hours, now],
  );
  const key = (r: { area_id: string; day: string; start_hour: number }) =>
    `${r.area_id}|${r.day}|${r.start_hour}`;
  const byHold = new Map<string, Hold>();
  for (const r of holds.rows) {
    const h = byHold.get(r.hold_id) ?? {
      holdId: r.hold_id,
      lines: [],
      until: r.until.getTime() / 1000,
      by: '',
    };
    byHold.set(r.hold_id, {
      ...h,
      lines: [
        ...h.lines,
        { areaId: r.area_id, date: r.day, startHour: r.start_hour, bikes: r.bikes },
      ],
    });
  }
  const manual = new Map(
    limits.rows.filter((r) => r.max_bikes !== null).map((r) => [key(r), r.max_bikes as number]),
  );
  // After the POC, area-hours without a manual limit are capped by the supply forecast (P1.3.7).
  const book = priceBookAt(await priceBooks(c), isoAt(now));
  if (book?.capacity.mode === 'forecast') {
    const missing = lines.filter((l) => !manual.has(areaHourKey(l)));
    for (const [k, v] of await forecastLimits(c, missing, book.capacity, now)) manual.set(k, v);
  }
  return {
    limits: manual,
    sold: new Map(sold.rows.map((r) => [key(r), Number(r.bikes)])),
    holds: [...byHold.values()],
  };
}

export class CapacityError extends Error {
  constructor(readonly shortfalls: ReturnType<typeof capacityProblems>) {
    super(
      `Not enough bikes left: ${shortfalls.map((s) => `${s.key} (${s.free} free)`).join(', ')}`,
    );
  }
}

/** A super admin sets (or with `null` lifts) a manual limit on one area-hour. */
export async function setAreaHourLimit(
  pool: Pool,
  l: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>,
  maxBikes: number | null,
  setBy: string,
): Promise<void> {
  lineStartsAt(l);
  await inTransaction(pool, async (c) => {
    await lockInventory(c);
    await c.query(
      `INSERT INTO area_hour_limits (area_id, day, start_hour, version, max_bikes, set_by)
       SELECT $1, $2, $3, coalesce(max(version), 0) + 1, $4, $5
         FROM area_hour_limits WHERE area_id = $1 AND day = $2 AND start_hour = $3`,
      [l.areaId, l.date, l.startHour, maxBikes, setBy],
    );
  });
}

/** A sales hold: keeps inventory for a client until `until` (no money). */
export async function placeHold(
  pool: Pool,
  hold: {
    holdId: string;
    brandId: string;
    lines: readonly BookingLine[];
    until: number;
    by: string;
  },
  now: number,
): Promise<void> {
  if (hold.until <= now) throw new RangeError('A hold must end in the future');
  for (const l of hold.lines) {
    lineStartsAt(l);
    if (!Number.isSafeInteger(l.bikes) || l.bikes < 1)
      throw new RangeError('bikes must be a whole number');
  }
  await inTransaction(pool, async (c) => {
    await lockInventory(c);
    const short = capacityProblems(hold.lines, await inventoryFor(c, hold.lines, now), now);
    if (short.length > 0) throw new CapacityError(short);
    await c.query(
      'INSERT INTO holds (hold_id, brand_id, until, held_by) VALUES ($1, $2, to_timestamp($3), $4)',
      [hold.holdId, hold.brandId, hold.until, hold.by],
    );
    for (const l of hold.lines) {
      await c.query(
        'INSERT INTO hold_lines (hold_id, area_id, day, start_hour, bikes) VALUES ($1, $2, $3, $4, $5)',
        [hold.holdId, l.areaId, l.date, l.startHour, l.bikes],
      );
    }
  });
}

// ---------------------------------------------------------------- bookings

export interface NewBooking {
  readonly bookingId: string;
  readonly brandId: string;
  readonly request: BookingRequest;
  readonly by: string;
  /** The hold this booking comes from, if any (its bikes are not counted against it). */
  readonly holdId?: string;
  /** Present for a free trial: the business it is for. */
  readonly trialFor?: Business;
}

/**
 * Checks, prices and saves a booking as a draft, using the price book in force now and the areas in
 * force at each line's hour. Throws BookingError, CapacityError or an Error naming the problem.
 */
export async function createBooking(pool: Pool, b: NewBooking, now: number): Promise<Quote> {
  return inTransaction(pool, async (c) => {
    await lockInventory(c);
    const book = priceBookAt(await priceBooks(c), isoAt(now));
    if (!book) throw new Error('No price book in force');
    const areas = await allAreaVersions(c);
    if (b.holdId !== undefined) {
      // Only the hold's own brand can book against it, and only while it lasts.
      const h = await c.query<{ brand_id: string; until: Date }>(
        'SELECT brand_id, until FROM holds WHERE hold_id = $1',
        [b.holdId],
      );
      const hold = h.rows[0];
      if (!hold) throw new Error(`No hold ${b.holdId}`);
      if (hold.brand_id !== b.brandId) throw new Error('This hold belongs to another brand');
      if (hold.until.getTime() / 1000 <= now) throw new Error('This hold has ended');
    }
    let q: Quote;
    if (b.trialFor) {
      const used = await c.query<{ identity: string }>(
        'SELECT identity FROM trials_used WHERE identity = ANY($1)',
        [trialKeys(b.trialFor) ?? []],
      );
      const problem = trialProblem(
        b.request.lines,
        b.trialFor,
        new Set(used.rows.map((r) => r.identity)),
        book,
      );
      if (problem) throw new Error(problem);
      // Same checks as any booking, but free and without the minimums.
      const priced = quote(
        b.request,
        { ...book, minBikesPerLine: 1, minBookingPaise: 0 },
        areas,
        now,
      );
      const free = paise(0);
      q = {
        ...priced,
        lines: priced.lines.map((l) => ({ ...l, paisePerBikeHour: 0, paise: free })),
        listSubtotal: free,
        discount: free,
        subtotal: free,
        gst: free,
        total: free,
      };
    } else {
      q = quote(b.request, book, areas, now);
    }
    const short = capacityProblems(
      b.request.lines,
      await inventoryFor(c, b.request.lines, now),
      now,
      b.holdId,
    );
    if (short.length > 0) throw new CapacityError(short);
    const t = timingOf(b.request.lines, book.adsDueDays);
    await c.query(
      `INSERT INTO bookings (booking_id, brand_id, channel, trial, repeat_months, price_book_version,
         subtotal_paise, gst_paise, total_paise, first_hour_at, last_hour_ends_at, ads_due_at, created_by, hold_id,
         discount_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11), to_timestamp($12), $13, $14, $15)`,
      [
        b.bookingId,
        b.brandId,
        b.request.channel,
        b.trialFor !== undefined,
        b.request.repeatMonths,
        q.priceBookVersion,
        q.subtotal,
        q.gst,
        q.total,
        t.firstHourAt,
        t.lastHourEndsAt,
        q.adsDueAt,
        b.by,
        b.holdId ?? null,
        q.discount,
      ],
    );
    for (const l of q.lines) {
      await c.query(
        `INSERT INTO booking_lines (booking_id, area_id, area_version, day, start_hour, bikes, paise_per_bike_hour, plays, paise)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          b.bookingId,
          l.areaId,
          l.areaVersion,
          l.date,
          l.startHour,
          l.bikes,
          l.paisePerBikeHour,
          l.plays,
          l.paise,
        ],
      );
    }
    if (b.trialFor) {
      // The key makes a second trial impossible even if two requests arrive at once.
      for (const identity of trialKeys(b.trialFor) ?? []) {
        await c.query('INSERT INTO trials_used (identity, booking_id) VALUES ($1, $2)', [
          identity,
          b.bookingId,
        ]);
      }
    }
    await c.query(
      `INSERT INTO booking_events (booking_id, seq, state, at, by_who) VALUES ($1, 1, 'draft', to_timestamp($2), $3)`,
      [b.bookingId, now, b.by],
    );
    return q;
  });
}

export async function bookingState(
  pool: Pick<Pool, 'query'>,
  bookingId: string,
): Promise<BookingState | undefined> {
  const r = await pool.query<{ state: BookingState }>(
    'SELECT state FROM booking_events WHERE booking_id = $1 ORDER BY seq DESC LIMIT 1',
    [bookingId],
  );
  return r.rows[0]?.state;
}

/** Who asks for a step, and why (a reason is needed for short-notice ad approvals). */
export interface StepBy {
  readonly by: string;
  readonly actor: Actor;
  readonly reason?: string;
  /** For the move to paid: the payment's id at the gateway (P1.7.2). */
  readonly paymentId?: string;
}

/** Moves a booking to its next step, if the rules allow it now; logs who and why. */
export async function moveBooking(
  pool: Pool,
  bookingId: string,
  to: BookingState,
  who: StepBy,
  now: number,
): Promise<void> {
  await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${bookingId}`]);
    const r = await c.query<{
      seq: number;
      state: BookingState;
      first_hour_at: Date;
      last_hour_ends_at: Date;
      ads_due_at: Date;
      channel: 'portal' | 'admin';
      price_book_version: number;
      trial: boolean;
    }>(
      `SELECT e.seq, e.state, b.first_hour_at, b.last_hour_ends_at, b.ads_due_at, b.channel,
              b.price_book_version, b.trial
         FROM booking_events e JOIN bookings b USING (booking_id)
        WHERE e.booking_id = $1 ORDER BY e.seq DESC LIMIT 1`,
      [bookingId],
    );
    const last = r.rows[0];
    if (!last) throw new Error(`No booking ${bookingId}`);
    const timing = {
      firstHourAt: last.first_hour_at.getTime() / 1000,
      lastHourEndsAt: last.last_hour_ends_at.getTime() / 1000,
      adsDueAt: last.ads_due_at.getTime() / 1000,
    };
    if (who.paymentId !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(who.paymentId))
      throw new Error('Payment id must be 1–80 letters, digits, dots, dashes or underscores');
    const problem = stepProblem(last.state, to, now, timing, who.actor, who.reason);
    if (problem) throw new Error(problem);
    if (last.state === 'draft' && to === 'awaiting-payment' && !last.trial) {
      // The draft's prices must still be the ones in force, and portal brands still need the lead time.
      const book = priceBookAt(await priceBooks(c), isoAt(now));
      if (book?.version !== last.price_book_version)
        throw new Error('Prices changed since this draft; make a new quote');
      if (last.channel === 'portal' && timing.firstHourAt < now + book.portalLeadDays * 86_400) {
        throw new Error(`Brands need to book ${book.portalLeadDays} days ahead`);
      }
    }
    if (last.state === 'draft' && to === 'awaiting-payment') {
      // Drafts hold no bikes; the moment a draft becomes a sale, check the limits again.
      await lockInventory(c);
      const lines = await c.query<{
        area_id: string;
        day: string;
        start_hour: number;
        bikes: number;
        hold_id: string | null;
      }>(
        `SELECT bl.area_id, bl.day::text, bl.start_hour, bl.bikes, b.hold_id
           FROM booking_lines bl JOIN bookings b USING (booking_id) WHERE bl.booking_id = $1`,
        [bookingId],
      );
      const mine = lines.rows.map((x) => ({
        areaId: x.area_id,
        date: x.day,
        startHour: x.start_hour,
        bikes: x.bikes,
      }));
      const short = capacityProblems(
        mine,
        await inventoryFor(c, mine, now),
        now,
        lines.rows[0]?.hold_id ?? undefined,
      );
      if (short.length > 0) throw new CapacityError(short);
    }
    await c.query(
      'INSERT INTO booking_events (booking_id, seq, state, at, by_who, reason) VALUES ($1, $2, $3, to_timestamp($4), $5, $6)',
      [bookingId, last.seq + 1, to, now, who.by, who.reason ?? null],
    );
    if (to === 'paid') {
      // P1.7.2: the advance (subtotal + GST) is held until plays are delivered; GST is owed at once.
      const m = await c.query<{ brand_id: string; subtotal: string; gst: string }>(
        'SELECT brand_id, subtotal_paise AS subtotal, gst_paise AS gst FROM bookings WHERE booking_id = $1',
        [bookingId],
      );
      const b = m.rows[0];
      if (b && Number(b.subtotal) + Number(b.gst) > 0)
        await postEntry(
          c,
          bookingPaid({
            bookingId,
            brandId: b.brand_id,
            subtotal: Number(b.subtotal),
            gst: Number(b.gst),
            paymentId: who.paymentId ?? 'advance',
            at: now,
          }),
          who.by,
        );
    }
  });
}
