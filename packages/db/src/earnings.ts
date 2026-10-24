// P1.7.3: revenue earned hour by hour. At each hour close, the delivered part of every sold line
// moves from "held" to "earned"; when the line is finally settled (no refund needed, a refund
// rejected, or a refund approved), whatever is left is earned, so "held" ends at exactly 0.
import { earnedPaise, lineEarned, lineIdOf, lineStartsAt, type PriceBook } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { postEntry } from './ledger.js';
import { inTransaction, paidForLine, type OpenLine } from './makeups.js';
import { COUNTING, lineTotalsFor } from './plays.js';

/** What a line has moved to revenue so far (summed from the ledger). */
async function earnedSoFar(c: Pick<PoolClient, 'query'>, lineId: string): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT coalesce(sum(p.credit - p.debit), 0) AS n
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.ref = $1 AND p.account = 'revenue'`,
    [lineId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Moves what every sold line has earned so far from held to revenue (P1.7.3). Safe to run as often
 * as wanted: runs take turns, and each run posts only what is new. Returns the entries posted.
 */
export async function closeEarnings(pool: Pool, now: number): Promise<number> {
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    const books = await priceBooks(c);
    const today = new Date((now + 330 * 60) * 1000).toISOString().slice(0, 10);
    const open = await c.query<OpenLine & { brand_id: string }>(
      `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
              b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise, b.price_book_version, b.brand_id
         FROM booking_lines bl JOIN bookings b USING (booking_id)
         JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = ANY($1) AND NOT b.trial AND bl.day <= $2::date
          AND NOT EXISTS (SELECT 1 FROM line_earnings_closed x
                           WHERE x.line_id = bl.booking_id || '/' || bl.area_id || '/' || bl.day::text
                                 || '/' || bl.start_hour)
        ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
      [COUNTING, today],
    );
    let posted = 0;
    for (const l of open.rows) {
      const book = books.find((b) => b.version === l.price_book_version);
      if (!book) continue;
      const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
      if (
        now <
        lineStartsAt({ date: l.day, startHour: l.start_hour }) +
          3600 +
          book.makeUps.closeAfterSeconds
      )
        continue;
      const target = await targetFor(c, l, lineId, book, books);
      const e = lineEarned({
        lineId,
        brandId: l.brand_id,
        earnedNow: target.earned,
        earnedSoFar: await earnedSoFar(c, lineId),
        closeId: target.final ? 'final' : String(now),
        at: now,
      });
      if (e) {
        await postEntry(c, e, 'hour-close');
        posted += 1;
      }
      // Once its figure is final, the line is closed and not looked at again.
      if (target.final)
        await c.query('INSERT INTO line_earnings_closed (line_id) VALUES ($1)', [lineId]);
    }
    return posted;
  });
}

/** What a line should have earned by now, and whether that is its final figure. */
async function targetFor(
  c: PoolClient,
  l: OpenLine,
  lineId: string,
  book: PriceBook,
  books: readonly PriceBook[],
): Promise<{ earned: number; final: boolean }> {
  const paid = await paidForLine(c, l, book);
  const delivered =
    (await lineTotalsFor(c, lineId, books)).plays +
    (await lineTotalsFor(c, `${lineId}#1`, books)).plays +
    (await lineTotalsFor(c, `${lineId}#2`, books)).plays;
  const byPlays = earnedPaise(paid, l.plays, delivered);
  const s = await c.query<{ outcome: string; base: string | null; decision: string | null }>(
    `SELECT ls.outcome, r.base_paise AS base, d.decision
       FROM line_settlements ls
       LEFT JOIN refunds r ON r.line_id = ls.line_id
       LEFT JOIN refund_decisions d ON d.refund_id = r.refund_id
      WHERE ls.line_id = $1 AND ls.step = 'refund'`,
    [lineId],
  );
  const refund = s.rows[0];
  if (!refund) return { earned: byPlays, final: false };
  if (refund.outcome !== 'refund') return { earned: paid, final: true };
  const base = Number(refund.base ?? 0);
  if (refund.decision === 'approved') return { earned: paid - base, final: true };
  if (refund.decision === 'rejected') return { earned: paid, final: true };
  // Awaiting a super admin: never earn into the part that may be refunded.
  return { earned: Math.min(byPlays, paid - base), final: false };
}
