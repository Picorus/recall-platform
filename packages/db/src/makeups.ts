// P1.6 in the database: deciding make-ups and refunds for lines that ended short, feeding make-ups to
// the hour plans, and a super admin's decision on each refund.
import {
  bandOf,
  bpOf,
  discountShare,
  lineIdOf,
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

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
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

interface OpenLine {
  readonly booking_id: string;
  readonly area_id: string;
  readonly day: string;
  readonly start_hour: number;
  readonly plays: number;
  readonly paise: string;
  readonly trial: boolean;
  readonly discount_paise: string;
  readonly price_book_version: number;
}

/** What a line was really paid, before GST: its price less its share of a deal discount. */
async function paidForLine(c: PoolClient, l: OpenLine, book: PriceBook): Promise<number> {
  if (l.trial) return 0;
  const discounted = (h: number) => book.repeatOfferBands.includes(bandOf(book, h).name);
  const all = await c.query<{ start_hour: number; paise: string }>(
    'SELECT start_hour, paise FROM booking_lines WHERE booking_id = $1',
    [l.booking_id],
  );
  const discountedTotal = all.rows
    .filter((r) => discounted(r.start_hour))
    .reduce((n, r) => n + Number(r.paise), 0);
  return (
    Number(l.paise) -
    discountShare(
      Number(l.paise),
      discounted(l.start_hour),
      Number(l.discount_paise),
      discountedTotal,
    )
  );
}

/**
 * Makes every make-up and refund decision that is due at `now` (P1.6.1–4), and returns how many
 * were made. Safe to run as often as wanted, from several places at once: decisions are taken one
 * run at a time and each is recorded once.
 */
export async function settleDue(pool: Pool, now: number): Promise<number> {
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('settle-lines'))");
    const books = await priceBooks(c);
    const today = new Date((now + 330 * 60) * 1000).toISOString().slice(0, 10);
    const open = await c.query<OpenLine>(
      `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
              b.trial, b.discount_paise, b.price_book_version
         FROM booking_lines bl JOIN bookings b USING (booking_id)
         JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = ANY($1) AND bl.day <= $2::date
          AND NOT EXISTS (
            SELECT 1 FROM line_settlements ls
             WHERE ls.line_id = bl.booking_id || '/' || bl.area_id || '/' || bl.day::text || '/' || bl.start_hour
               AND (ls.step = 'refund' OR ls.outcome = 'not needed'))
        ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
      [COUNTING, today],
    );
    let made = 0;
    for (const l of open.rows) {
      const book = books.find((b) => b.version === l.price_book_version);
      if (!book) continue;
      const slot: LineSlot = {
        lineId: lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour),
        areaId: l.area_id,
        date: l.day,
        startHour: l.start_hour,
      };
      const rows = await c.query<{ step: string; outcome: string; owed: number }>(
        'SELECT step, outcome, owed FROM line_settlements WHERE line_id = $1',
        [slot.lineId],
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
        if (r.step === 'refund') done.refund = { missing: r.owed };
      }
      const delivered = {
        line: (await lineTotalsFor(c, slot.lineId)).plays,
        first: (await lineTotalsFor(c, `${slot.lineId}#1`)).plays,
        second: (await lineTotalsFor(c, `${slot.lineId}#2`)).plays,
      };
      const decide = (step: string, outcome: string, owed: number) =>
        c.query(
          'INSERT INTO line_settlements (line_id, step, outcome, owed) VALUES ($1, $2, $3, $4)',
          [slot.lineId, step, outcome, owed],
        );
      const openMakeUp = (m: MakeUpWindow, owed: number) =>
        c.query(
          `INSERT INTO make_ups (make_up_id, line_id, booking_id, area_id, stage, day, hours,
             window_from, window_until, plays)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, to_timestamp($8), to_timestamp($9), $10)`,
          [
            m.makeUpId,
            slot.lineId,
            l.booking_id,
            m.areaId,
            m.stage,
            m.date,
            m.hours,
            m.from,
            m.until,
            owed,
          ],
        );
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
            const base = refundPaise(step.missing, l.plays, paid);
            await c.query(
              `INSERT INTO refunds (refund_id, line_id, booking_id, missing_plays, promised_plays,
                 paid_paise, base_paise, gst_paise, price_book_version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                `${slot.lineId}#refund`,
                slot.lineId,
                l.booking_id,
                step.missing,
                l.plays,
                paid,
                base,
                bpOf(base, book.gstBp),
                book.version,
              ],
            );
            await decide('refund', 'refund', step.missing);
          }
          done.refund = { missing: step.missing };
        }
      }
    }
    return made;
  });
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
  for (const m of r.rows) {
    const left = m.plays - (await lineTotalsFor(pool, m.make_up_id)).plays;
    if (left > 0) out.push({ makeUpId: m.make_up_id, brandId: m.brand_id, plays: left });
  }
  return out;
}

/** A super admin approves or rejects a proposed refund (Prateek, 22 Oct 2026). Decided once. */
export async function decideRefund(
  pool: Pool,
  refundId: string,
  decision: 'approved' | 'rejected',
  by: { readonly id: string; readonly role: string },
  reason: string,
): Promise<void> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can decide a refund');
  await inTransaction(pool, (c) =>
    c.query(
      'INSERT INTO refund_decisions (refund_id, decision, decided_by, reason) VALUES ($1, $2, $3, $4)',
      [refundId, decision, by.id, reason],
    ),
  );
}
