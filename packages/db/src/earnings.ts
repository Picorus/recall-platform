// P1.7.3: revenue earned hour by hour. At each hour close, the delivered part of every sold line
// moves from "held" to "earned". When the line is finally settled (no refund needed, a refund
// rejected or approved, or the booking forfeited because its ads never came), whatever is left is
// earned, so "held" ends at exactly 0, and the line is closed.
import {
  earnedPaise,
  lineEarned,
  lineIdOf,
  lineStartsAt,
  refundApproved,
  type PriceBook,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { postEntry } from './ledger.js';
import { inTransaction, paidForLine, type OpenLine } from './makeups.js';
import { COUNTING, lineTotalsFor } from './plays.js';

type Line = OpenLine & { readonly brand_id: string; readonly state: string };

/** Lines of paid bookings whose earnings are not closed yet (optionally one line). */
async function openLines(c: PoolClient, today: string, lineId?: string): Promise<Line[]> {
  const r = await c.query<Line>(
    `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.plays, bl.paise,
            b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise, b.price_book_version, b.brand_id,
            s.state
       FROM booking_lines bl JOIN bookings b USING (booking_id)
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                      ORDER BY seq DESC LIMIT 1) s ON true
      WHERE NOT b.trial AND bl.day <= $1::date
        AND (s.state = ANY($2) OR s.state IN ('ads-missing', 'cancelled'))
        AND EXISTS (SELECT 1 FROM booking_events p WHERE p.booking_id = bl.booking_id AND p.state = 'paid')
        AND NOT EXISTS (SELECT 1 FROM line_earnings_closed x
                         WHERE x.line_id = bl.booking_id || '/' || bl.area_id || '/' || bl.day::text
                               || '/' || bl.start_hour)
        AND ($3::text IS NULL
             OR bl.booking_id || '/' || bl.area_id || '/' || bl.day::text || '/' || bl.start_hour = $3)
      ORDER BY bl.day, bl.start_hour, bl.booking_id, bl.area_id`,
    [today, COUNTING, lineId ?? null],
  );
  return r.rows;
}

/** What a line has moved to revenue so far, and how many earned entries it has (from the ledger). */
async function earnedSoFar(c: Pick<PoolClient, 'query'>, lineId: string) {
  const r = await c.query<{ n: string; k: string }>(
    `SELECT coalesce(sum(p.credit - p.debit), 0) AS n,
            count(DISTINCT e.entry_id) FILTER (WHERE e.kind LIKE 'line-earned%') AS k
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.ref = $1 AND p.account = 'revenue'`,
    [lineId],
  );
  return { paise: Number(r.rows[0]?.n ?? 0), entries: Number(r.rows[0]?.k ?? 0) };
}

/** What a line should have earned by now, and whether that is its final figure. */
async function targetFor(
  c: PoolClient,
  l: Line,
  lineId: string,
  paid: number,
  books: readonly PriceBook[],
): Promise<{ earned: number; final: boolean }> {
  // Ads never came: no refund (rulebook v5.4); everything paid is earned.
  if (l.state === 'ads-missing') return { earned: paid, final: true };
  const s = await c.query<{ outcome: string; base: string | null; decision: string | null }>(
    `SELECT ls.outcome, r.base_paise AS base, d.decision
       FROM line_settlements ls
       LEFT JOIN refunds r ON r.line_id = ls.line_id
       LEFT JOIN refund_decisions d ON d.refund_id = r.refund_id
      WHERE ls.line_id = $1 AND ls.step = 'refund'`,
    [lineId],
  );
  const refund = s.rows[0];
  if (refund && refund.outcome !== 'refund') return { earned: paid, final: true };
  if (refund?.decision === 'approved')
    return { earned: paid - Number(refund.base ?? 0), final: true };
  if (refund?.decision === 'rejected') return { earned: paid, final: true };
  // A cancelled booking earns nothing while its refund is decided.
  if (l.state === 'cancelled') return { earned: 0, final: false };
  const delivered =
    (await lineTotalsFor(c, lineId, books)).plays +
    (await lineTotalsFor(c, `${lineId}#1`, books)).plays +
    (await lineTotalsFor(c, `${lineId}#2`, books)).plays;
  const byPlays = earnedPaise(paid, l.plays, delivered);
  // Awaiting a super admin: never earn into the part that may be refunded.
  return {
    earned: refund ? Math.min(byPlays, paid - Number(refund.base ?? 0)) : byPlays,
    final: false,
  };
}

/** Brings one line's revenue up (or down) to what it has earned; closes it when final. */
async function closeLine(
  c: PoolClient,
  l: Line,
  books: readonly PriceBook[],
  paidCache: Map<string, number>,
  now: number,
  by: string,
): Promise<number> {
  const book = books.find((b) => b.version === l.price_book_version);
  if (!book) throw new Error(`price book ${l.price_book_version} not found`);
  const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
  const settledNow = l.state === 'ads-missing' || l.state === 'cancelled';
  if (
    !settledNow &&
    now <
      lineStartsAt({ date: l.day, startHour: l.start_hour }) + 3600 + book.makeUps.closeAfterSeconds
  )
    return 0;
  let paid = paidCache.get(lineId);
  if (paid === undefined) {
    paid = await paidForLine(c, l, book);
    paidCache.set(lineId, paid);
  }
  const target = await targetFor(c, l, lineId, paid, books);
  const so = await earnedSoFar(c, lineId);
  const e = lineEarned({
    lineId,
    brandId: l.brand_id,
    earnedNow: target.earned,
    earnedSoFar: so.paise,
    // Numbered per line: under the lock each close gets the next number, never one already used.
    closeId: String(so.entries + 1),
    at: now,
  });
  if (e) await postEntry(c, e, by);
  if (target.final)
    await c.query('INSERT INTO line_earnings_closed (line_id) VALUES ($1)', [lineId]);
  return e ? 1 : 0;
}

const todayOf = (now: number) => new Date((now + 330 * 60) * 1000).toISOString().slice(0, 10);

/**
 * Moves what every sold line has earned so far from held to revenue (P1.7.3). Safe to run as often
 * as wanted: runs take turns, and each posts only what is new. Each line on its own: one that fails
 * does not hold up the others. Returns the entries posted and the lines that failed.
 */
export async function closeEarnings(
  pool: Pool,
  now: number,
): Promise<{ posted: number; failed: { lineId: string; error: string }[] }> {
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    const books = await priceBooks(c);
    const paidCache = new Map<string, number>();
    let posted = 0;
    const failed: { lineId: string; error: string }[] = [];
    for (const l of await openLines(c, todayOf(now))) {
      await c.query('SAVEPOINT line');
      try {
        posted += await closeLine(c, l, books, paidCache, now, 'hour-close');
        await c.query('RELEASE SAVEPOINT line');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT line');
        failed.push({
          lineId: lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour),
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { posted, failed };
  });
}

/**
 * A super admin approves or rejects a proposed refund (Prateek, 22 Oct 2026). Decided once. In the
 * same step the line's earnings are settled: an approved refund's credit note (the undelivered part
 * and its GST) is owed back to the brand, and the rest is earned; a rejected one is earned in full.
 */
export async function decideRefund(
  pool: Pool,
  refundId: string,
  decision: 'approved' | 'rejected',
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can decide a refund');
  await inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    await c.query(
      'INSERT INTO refund_decisions (refund_id, decision, decided_by, reason) VALUES ($1, $2, $3, $4)',
      [refundId, decision, by.id, reason],
    );
    const r = await c.query<{ line_id: string; brand_id: string; base: string; gst: string }>(
      `SELECT r.line_id, b.brand_id, r.base_paise AS base, r.gst_paise AS gst
         FROM refunds r JOIN bookings b USING (booking_id) WHERE r.refund_id = $1`,
      [refundId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`No refund ${refundId}`);
    if (decision === 'approved' && Number(row.base) + Number(row.gst) > 0)
      await postEntry(
        c,
        refundApproved({
          refundId,
          lineId: row.line_id,
          brandId: row.brand_id,
          base: Number(row.base),
          gst: Number(row.gst),
          at: now,
        }),
        by.id,
      );
    const [line] = await openLines(c, '9999-12-31', row.line_id);
    if (line) await closeLine(c, line, await priceBooks(c), new Map(), now, by.id);
  });
}
