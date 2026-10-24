// P1.7.3: revenue earned hour by hour. At each hour close, the delivered part of every sold line
// moves from "held" to "earned". When the line is finally settled (no refund needed, a refund
// rejected or approved, or the booking forfeited because its ads never came), whatever is left is
// earned, so "held" ends at exactly 0, and the line is closed.
import {
  bpOf,
  earnedPaise,
  lineEarned,
  lineIdOf,
  lineStartsAt,
  refundApproved,
  refundPaise,
  type PriceBook,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { accrueCuts } from './cuts.js';
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
      WHERE NOT b.trial
        AND ((s.state = ANY($2) AND bl.day <= $1::date) OR s.state IN ('ads-missing', 'cancelled'))
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

/**
 * What a line has moved to revenue so far, in its two parts (delivered by plays, and kept without
 * delivery), and how many entries of each it has (from the ledger).
 */
async function earnedSoFar(c: Pick<PoolClient, 'query'>, lineId: string) {
  const r = await c.query<{ d: string; k: string; dn: string; kn: string }>(
    `SELECT coalesce(sum(p.credit - p.debit) FILTER (WHERE e.kind LIKE 'line-earned%'), 0) AS d,
            coalesce(sum(p.credit - p.debit) FILTER (WHERE e.kind LIKE 'line-kept%'), 0) AS k,
            count(DISTINCT e.entry_id) FILTER (WHERE e.kind LIKE 'line-earned%') AS dn,
            count(DISTINCT e.entry_id) FILTER (WHERE e.kind LIKE 'line-kept%') AS kn
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.ref = $1 AND p.account = 'revenue'`,
    [lineId],
  );
  const row = r.rows[0];
  return {
    delivered: Number(row?.d ?? 0),
    kept: Number(row?.k ?? 0),
    deliveredEntries: Number(row?.dn ?? 0),
    keptEntries: Number(row?.kn ?? 0),
  };
}

/** Plays counted for a line and its two make-ups. */
async function playsFor(c: PoolClient, lineId: string, books: readonly PriceBook[]) {
  return (
    (await lineTotalsFor(c, lineId, books)).plays +
    (await lineTotalsFor(c, `${lineId}#1`, books)).plays +
    (await lineTotalsFor(c, `${lineId}#2`, books)).plays
  );
}

/** What approved refunds of a line have given back from held (its credit notes, before GST). */
async function refundedFor(c: PoolClient, lineId: string) {
  const r = await c.query<{ n: string }>(
    `SELECT coalesce(sum(p.debit - p.credit), 0) AS n
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE e.ref = $1 AND e.kind = 'refund-approved' AND p.account = 'campaign-held'`,
    [lineId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * What a line should have earned by now, split into what its plays delivered and what is kept
 * without delivery, and whether that is its final figure.
 */
async function targetFor(
  c: PoolClient,
  l: Line,
  lineId: string,
  paid: number,
  books: readonly PriceBook[],
): Promise<{ delivered: number; kept: number; final: boolean }> {
  const byPlays = async () => earnedPaise(paid, l.plays, await playsFor(c, lineId, books));
  /** Final: `total` is earned; the part its plays delivered is delivered, the rest is kept. */
  const settle = async (total: number) => {
    const delivered = Math.min(await byPlays(), total);
    return { delivered, kept: total - delivered, final: true };
  };
  // Ads never came: no refund (rulebook v5.4); everything paid is kept.
  if (l.state === 'ads-missing') return settle(paid);
  const s = await c.query<{ outcome: string; base: string | null; decision: string | null }>(
    `SELECT ls.outcome, r.base_paise AS base, d.decision
       FROM line_settlements ls
       LEFT JOIN refunds r ON r.line_id = ls.line_id
       LEFT JOIN refund_decisions d ON d.refund_id = r.refund_id
      WHERE ls.line_id = $1 AND ls.step = 'refund'`,
    [lineId],
  );
  const refund = s.rows[0];
  if (refund && refund.outcome !== 'refund') return settle(paid);
  // What the credit notes gave back (the proposed refund, plus any top-up at approval).
  if (refund?.decision === 'approved') return settle(paid - (await refundedFor(c, lineId)));
  if (refund?.decision === 'rejected') return settle(paid);
  // A cancelled booking earns nothing while its refund is decided (or until the decision step runs).
  if (l.state === 'cancelled') return { delivered: 0, kept: 0, final: false };
  const delivered = await byPlays();
  // Awaiting a super admin: never earn into the part that may be refunded.
  return {
    delivered: refund ? Math.min(delivered, paid - Number(refund.base ?? 0)) : delivered,
    kept: 0,
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
  // Numbered per line and part: under the lock each close gets the next number, never one used.
  const entries = [
    lineEarned({
      lineId,
      brandId: l.brand_id,
      earnedNow: target.delivered,
      earnedSoFar: so.delivered,
      closeId: String(so.deliveredEntries + 1),
      at: now,
    }),
    lineEarned({
      lineId,
      brandId: l.brand_id,
      earnedNow: target.kept,
      earnedSoFar: so.kept,
      closeId: String(so.keptEntries + 1),
      at: now,
      part: 'kept',
    }),
  ].filter((e) => e !== undefined);
  for (const e of entries) await postEntry(c, e, by);
  if (target.final)
    await c.query('INSERT INTO line_earnings_closed (line_id) VALUES ($1)', [lineId]);
  return entries.length;
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
    // A cancellation refund left undecided past its deadline (from the cancellation, or from when
    // the refund was proposed if later) is taken as rejected: "not approved =
    // no refund" (Prateek, 24 Oct 2026). Recorded like any decision, by the system.
    await c.query(
      `INSERT INTO refund_decisions (refund_id, decision, decided_by, reason)
       SELECT r.refund_id, 'rejected', 'system', 'No super-admin decision in time: not approved, no refund'
         FROM refunds r JOIN bookings b USING (booking_id)
         JOIN price_books pb ON pb.version = b.price_book_version
         JOIN LATERAL (SELECT state, at FROM booking_events e WHERE e.booking_id = r.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM refund_decisions d WHERE d.refund_id = r.refund_id)
          AND greatest(s.at, r.proposed_at)
                + make_interval(hours => coalesce((pb.book ->> 'cancelRefundDecideHours')::int, 168))
              <= to_timestamp($1)`,
      [now],
    );
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
    // Cuts follow what each booking has delivered (only bookings RECALL gave a cut on). Every such
    // booking is looked at, so a cut given late is still paid; each posts only what is new.
    const withCuts = await c.query<{ booking_id: string }>(
      'SELECT DISTINCT booking_id FROM booking_cuts ORDER BY booking_id',
    );
    for (const b of withCuts.rows) {
      await c.query('SAVEPOINT cut');
      try {
        posted += await accrueCuts(c, b.booking_id, now, 'hour-close');
        await c.query('RELEASE SAVEPOINT cut');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT cut');
        failed.push({ lineId: b.booking_id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { posted, failed };
  });
}

/**
 * A super admin approves or rejects a proposed refund (Prateek, 22 Oct 2026). Decided once. In the
 * same step the line's earnings are settled: an approved refund's credit note (the undelivered part
 * and its GST) is owed back to the brand, and the rest is earned; a rejected one is earned in full.
 * If more plays are missing at approval than when the refund was proposed (a stolen screen found
 * meanwhile), the credit note is topped up: brands pay only for what was delivered.
 * Returns the error if the line's cuts could not be brought in line (the next close retries).
 */
export async function decideRefund(
  pool: Pool,
  refundId: string,
  decision: 'approved' | 'rejected',
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ cutError?: string }> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can decide a refund');
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    const before = await c.query<{ decision: string; decided_by: string; at: string }>(
      `SELECT decision, decided_by, decided_at::text AS at FROM refund_decisions
        WHERE refund_id = $1`,
      [refundId],
    );
    const done = before.rows[0];
    if (done)
      throw new Error(
        `Refund ${refundId} was already ${done.decision} by ${done.decided_by} at ${done.at}`,
      );
    const r = await c.query<{ line_id: string; brand_id: string; base: string; gst: string }>(
      `SELECT r.line_id, b.brand_id, r.base_paise AS base, r.gst_paise AS gst
         FROM refunds r JOIN bookings b USING (booking_id) WHERE r.refund_id = $1`,
      [refundId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`No refund ${refundId}`);
    await c.query(
      'INSERT INTO refund_decisions (refund_id, decision, decided_by, reason) VALUES ($1, $2, $3, $4)',
      [refundId, decision, by.id, reason],
    );
    const books = await priceBooks(c);
    const [line] = await openLines(c, '9999-12-31', row.line_id);
    if (decision === 'approved') {
      const base = Number(row.base);
      const gst = Number(row.gst);
      const credit = (id: string, b: number, g: number) =>
        postEntry(
          c,
          refundApproved({
            refundId: id,
            lineId: row.line_id,
            brandId: row.brand_id,
            base: b,
            gst: g,
            at: now,
          }),
          by.id,
        );
      if (base + gst > 0) await credit(refundId, base, gst);
      const book = line && books.find((b) => b.version === line.price_book_version);
      if (line && book) {
        const paid = await paidForLine(c, line, book);
        const missing = Math.max(
          0,
          line.plays - Math.min(line.plays, await playsFor(c, row.line_id, books)),
        );
        const more = Math.min(refundPaise(missing, line.plays, paid), paid) - base;
        if (more > 0) await credit(`${refundId}+more`, more, bpOf(more, book.gstBp));
      }
    }
    if (line) await closeLine(c, line, books, new Map(), now, by.id);
    // A cut that cannot be brought in line now never undoes the decision: the next close does it.
    await c.query('SAVEPOINT cut');
    try {
      await accrueCuts(c, row.line_id.split('/')[0] ?? '', now, by.id);
      await c.query('RELEASE SAVEPOINT cut');
      return {};
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT cut');
      return { cutError: e instanceof Error ? e.message : String(e) };
    }
  });
}
