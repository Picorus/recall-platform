// P1.6 in the database: deciding make-ups and refunds for lines that ended short, feeding make-ups to
// the hour plans, and a super admin's decision on each refund.
import {
  bandOf,
  bpOf,
  discountShares,
  lineIdOf,
  nextDecisionAt,
  nextSettlementStep,
  refundPaise,
  type LineSlot,
  type MakeUpWindow,
  type PriceBook,
  type Settlement,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { COUNTING, lineTotalsFor } from './plays.js';

export async function inTransaction<T>(
  pool: Pool,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export interface OpenLine {
  readonly booking_id: string;
  readonly area_id: string;
  readonly day: string;
  readonly start_hour: number;
  readonly plays: number;
  readonly paise: string;
  readonly trial: boolean;
  readonly discount_paise: string;
  readonly subtotal_paise: string;
  readonly gst_paise: string;
  readonly price_book_version: number;
}

/** What a line was really paid, before GST: its price less its exact share of a deal discount. */
export async function paidForLine(c: PoolClient, l: OpenLine, book: PriceBook): Promise<number> {
  if (l.trial) return 0;
  const all = await c.query<{ area_id: string; day: string; start_hour: number; paise: string }>(
    `SELECT area_id, day::text AS day, start_hour, paise FROM booking_lines WHERE booking_id = $1
      ORDER BY day, start_hour, area_id`,
    [l.booking_id],
  );
  const shares = discountShares(
    all.rows.map((r) => ({
      paise: Number(r.paise),
      discounted: book.repeatOfferBands.includes(bandOf(book, r.start_hour).name),
    })),
    Number(l.discount_paise),
  );
  const i = all.rows.findIndex(
    (r) => r.area_id === l.area_id && r.day === l.day && r.start_hour === l.start_hour,
  );
  return Number(l.paise) - (shares[i] ?? 0);
}

/**
 * What a booking's refunds give back so far, before and after GST (proposals and top-ups): never
 * more, over all of them, than its bill.
 */
export async function refundedOnBooking(c: Pick<PoolClient, 'query'>, bookingId: string) {
  const r = await c.query<{ base: string; gst: string }>(
    `SELECT coalesce(sum(base_paise), 0) AS base, coalesce(sum(gst_paise), 0) AS gst
       FROM (SELECT base_paise, gst_paise FROM refunds WHERE booking_id = $1
             UNION ALL
             SELECT base_paise, gst_paise FROM refund_topups WHERE booking_id = $1) x`,
    [bookingId],
  );
  return { base: Number(r.rows[0]?.base ?? 0), gst: Number(r.rows[0]?.gst ?? 0) };
}

/** A make-up that opened: its area-hours' plans must be re-sent with it (`addMakeUps`). */
export interface OpenedMakeUp {
  readonly makeUpId: string;
  readonly areaId: string;
  readonly date: string;
  readonly hours: readonly number[];
}

export interface Settled {
  /** Decisions made in this run. */
  readonly decisions: number;
  readonly opened: readonly OpenedMakeUp[];
  /** Lines that could not be decided (each on its own: the others still were), with why. */
  readonly failed: readonly { readonly lineId: string; readonly error: string }[];
}

/**
 * Makes every make-up and refund decision that is due at `now` (P1.6.1–4). Safe to run as often as
 * wanted, from several places at once: runs take turns, and each decision is recorded once. Each
 * line is decided on its own, so a line that fails does not hold up the others.
 */
export async function settleDue(pool: Pool, now: number): Promise<Settled> {
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('settle-lines'))");
    const books = await priceBooks(c);
    const today = new Date((now + 330 * 60) * 1000).toISOString().slice(0, 10);
    const open = await c.query<OpenLine>(
      `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
              b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise, b.price_book_version
         FROM booking_lines bl JOIN bookings b USING (booking_id)
         JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = ANY($1) AND bl.day <= $2::date
          AND NOT EXISTS (
            SELECT 1 FROM line_settlements ls
             WHERE ls.line_id = bl.booking_id || '/' || bl.area_id || '/' || bl.day::text || '/' || bl.start_hour
               AND ls.step = 'refund')
        ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
      [COUNTING, today],
    );
    let decisions = 0;
    const opened: OpenedMakeUp[] = [];
    const failed: { lineId: string; error: string }[] = [];
    for (const l of open.rows) {
      const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
      await c.query('SAVEPOINT line');
      try {
        const made = await settleLine(c, l, lineId, books, now, opened);
        decisions += made;
        await c.query('RELEASE SAVEPOINT line');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT line');
        failed.push({ lineId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // A booking cancelled after it was paid (Prateek, 24 Oct 2026): no refund by default. Cancelled at
    // least `cancelRefundHours` before its first hour, a full refund of each line is proposed, which a
    // super admin may approve; later than that, nothing can be refunded.
    const cancelled = await c.query<OpenLine & { cancelled_at: string; first_hour_at: string }>(
      `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
              b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise, b.price_book_version,
              extract(epoch FROM s.at)::bigint AS cancelled_at,
              extract(epoch FROM b.first_hour_at)::bigint AS first_hour_at
         FROM booking_lines bl JOIN bookings b USING (booking_id)
         JOIN LATERAL (SELECT state, at FROM booking_events e WHERE e.booking_id = bl.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = 'cancelled' AND NOT b.trial
          AND EXISTS (SELECT 1 FROM booking_events p WHERE p.booking_id = bl.booking_id AND p.state = 'paid')
          AND NOT EXISTS (
            SELECT 1 FROM line_settlements ls
             WHERE ls.line_id = bl.booking_id || '/' || bl.area_id || '/' || bl.day::text || '/' || bl.start_hour
               AND ls.step = 'refund')
        ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
    );
    for (const l of cancelled.rows) {
      const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
      await c.query('SAVEPOINT line');
      try {
        const book = books.find((b) => b.version === l.price_book_version);
        if (!book) throw new Error(`price book ${l.price_book_version} not found`);
        // Early enough: a full refund is proposed (a super admin may approve it; otherwise no
        // refund). Too late: nothing can be refunded, the money is earned.
        if (Number(l.cancelled_at) <= Number(l.first_hour_at) - book.cancelRefundHours * 3600)
          await proposeRefund(c, l, lineId, book, l.plays, now);
        else
          await c.query(
            `INSERT INTO line_settlements (line_id, step, outcome, owed) VALUES ($1, 'refund', 'forfeited', 0)`,
            [lineId],
          );
        decisions += 1;
        await c.query('RELEASE SAVEPOINT line');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT line');
        failed.push({ lineId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { decisions, opened, failed };
  });
}

/** Proposes a refund of `missing` plays of a line (capped by the booking's bill and GST). */
async function proposeRefund(
  c: PoolClient,
  l: OpenLine,
  lineId: string,
  book: PriceBook,
  missing: number,
  now: number,
): Promise<void> {
  const decide = (outcome: string) =>
    c.query(
      `INSERT INTO line_settlements (line_id, step, outcome, owed) VALUES ($1, 'refund', $2, $3)`,
      [lineId, outcome, missing],
    );
  const paid = await paidForLine(c, l, book);
  if (paid === 0 || missing === 0)
    return void (await decide(paid === 0 ? 'nothing paid' : 'not needed'));
  const before = await refundedOnBooking(c, l.booking_id);
  const base = Math.min(
    refundPaise(missing, l.plays, paid),
    Number(l.subtotal_paise) - before.base,
  );
  if (base <= 0) return void (await decide('not needed'));
  const gst = Math.min(bpOf(base, book.gstBp), Number(l.gst_paise) - before.gst);
  await c.query(
    `INSERT INTO refunds (refund_id, line_id, booking_id, missing_plays, promised_plays,
       paid_paise, base_paise, gst_paise, price_book_version, proposed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
    [
      `${lineId}#refund`,
      lineId,
      l.booking_id,
      missing,
      l.plays,
      paid,
      base,
      gst,
      book.version,
      now,
    ],
  );
  await decide('refund');
}

async function settleLine(
  c: PoolClient,
  l: OpenLine,
  lineId: string,
  books: readonly PriceBook[],
  now: number,
  opened: OpenedMakeUp[],
): Promise<number> {
  const book = books.find((b) => b.version === l.price_book_version);
  if (!book) throw new Error(`price book ${l.price_book_version} not found`);
  const slot: LineSlot = { lineId, areaId: l.area_id, date: l.day, startHour: l.start_hour };
  const rows = await c.query<{ step: string; outcome: string; owed: number }>(
    'SELECT step, outcome, owed FROM line_settlements WHERE line_id = $1',
    [lineId],
  );
  const done: { -readonly [K in keyof Settlement]: Settlement[K] } = {};
  for (const r of rows.rows) {
    if (r.step === 'first')
      done.first =
        r.outcome === 'not needed'
          ? 'not needed'
          : r.outcome === 'no window'
            ? 'no window'
            : { owed: r.owed };
    if (r.step === 'second')
      done.second = r.outcome === 'not needed' ? 'not needed' : { owed: r.owed };
  }
  // Nothing due yet: skip without counting anything.
  const dueAt = nextDecisionAt(slot, done, book.makeUps);
  if (dueAt === undefined || now < dueAt) return 0;
  const delivered = {
    line: (await lineTotalsFor(c, lineId, books)).plays,
    first: (await lineTotalsFor(c, `${lineId}#1`, books)).plays,
    second: (await lineTotalsFor(c, `${lineId}#2`, books)).plays,
  };
  const decide = (step: string, outcome: string, owed: number) =>
    c.query('INSERT INTO line_settlements (line_id, step, outcome, owed) VALUES ($1, $2, $3, $4)', [
      lineId,
      step,
      outcome,
      owed,
    ]);
  const openMakeUp = async (m: MakeUpWindow, owed: number) => {
    await c.query(
      `INSERT INTO make_ups (make_up_id, line_id, booking_id, area_id, stage, day, hours,
         window_from, window_until, plays)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, to_timestamp($8), to_timestamp($9), $10)`,
      [m.makeUpId, lineId, l.booking_id, m.areaId, m.stage, m.date, m.hours, m.from, m.until, owed],
    );
    opened.push({ makeUpId: m.makeUpId, areaId: m.areaId, date: m.date, hours: m.hours });
  };
  let made = 0;
  for (;;) {
    const step = nextSettlementStep(slot, l.plays, done, delivered, now, book.makeUps);
    if (!step) break;
    made += 1;
    if (step.step === 'first') {
      if (step.owed === 0) {
        await decide('first', 'not needed', 0);
        done.first = 'not needed';
      } else if (!step.window) {
        await decide('first', 'no window', step.owed);
        done.first = 'no window';
      } else {
        await openMakeUp(step.window, step.owed);
        await decide('first', 'make-up', step.owed);
        done.first = { owed: step.owed };
      }
    } else if (step.step === 'second') {
      if (step.owed === 0) {
        await decide('second', 'not needed', 0);
        done.second = 'not needed';
      } else {
        await openMakeUp(step.window, step.owed);
        await decide('second', 'make-up', step.owed);
        done.second = { owed: step.owed };
      }
    } else {
      const paid = await paidForLine(c, l, book);
      if (step.missing === 0) await decide('refund', 'not needed', 0);
      else if (paid === 0) await decide('refund', 'nothing paid', step.missing);
      else {
        // Never more, over all the booking's refunds, than its bill (before and after GST).
        const before = await refundedOnBooking(c, l.booking_id);
        const base = Math.min(
          refundPaise(step.missing, l.plays, paid),
          Number(l.subtotal_paise) - before.base,
        );
        if (base <= 0) {
          // Too little missing to come to a paisa: nothing to give back.
          await decide('refund', 'not needed', step.missing);
          done.refund = { missing: step.missing };
          continue;
        }
        const gst = Math.min(bpOf(base, book.gstBp), Number(l.gst_paise) - before.gst);
        await c.query(
          `INSERT INTO refunds (refund_id, line_id, booking_id, missing_plays, promised_plays,
             paid_paise, base_paise, gst_paise, price_book_version, proposed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
          [
            `${lineId}#refund`,
            lineId,
            l.booking_id,
            step.missing,
            l.plays,
            paid,
            base,
            gst,
            book.version,
            now,
          ],
        );
        await decide('refund', 'refund', step.missing);
      }
      done.refund = { missing: step.missing };
    }
  }
  return made;
}

/** Make-ups still owing plays in an area-hour, for its hour plan (P1.4.1). */
export async function makeUpsDue(
  pool: Pick<Pool, 'query'>,
  areaId: string,
  date: string,
  startHour: number,
): Promise<{ makeUpId: string; brandId: string; plays: number }[]> {
  const r = await pool.query<{ make_up_id: string; brand_id: string; plays: number }>(
    `SELECT m.make_up_id, b.brand_id, m.plays FROM make_ups m JOIN bookings b USING (booking_id)
      WHERE m.area_id = $1 AND m.day = $2::date AND $3 = ANY(m.hours) ORDER BY m.window_from, m.make_up_id`,
    [areaId, date, startHour],
  );
  const out: { makeUpId: string; brandId: string; plays: number }[] = [];
  const books = r.rows.length > 0 ? await priceBooks(pool) : [];
  for (const m of r.rows) {
    const left = m.plays - (await lineTotalsFor(pool, m.make_up_id, books)).plays;
    if (left > 0) out.push({ makeUpId: m.make_up_id, brandId: m.brand_id, plays: left });
  }
  return out;
}
