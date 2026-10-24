// P1.7.4 in the database: giving a cut on a booking (only when RECALL decides) and keeping each cut
// in line with what the booking has earned.
import { CUT_MAX_BP, cutAccrued, isoAt, priceBookAt, type Cut } from '@recall/domain';
import { priceBooks } from './bookings.js';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';

/**
 * Records that RECALL gives a cut on a booking (Prateek, 24 Oct 2026: never automatic). Decided once
 * per kind per booking. The rate defaults to the price book's in force (agency 10%, aggregator 2%),
 * and the TDS rate is that book's too.
 */
export async function giveCut(
  pool: Pool,
  cut: Omit<Cut, 'rateBp' | 'tdsBp'> & { readonly rateBp?: number },
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can give a cut');
  if (
    cut.rateBp !== undefined &&
    !(Number.isSafeInteger(cut.rateBp) && cut.rateBp >= 1 && cut.rateBp <= CUT_MAX_BP)
  )
    throw new RangeError('A cut rate must be 0.01–50% (whole basis points)');
  if (!(Number.isSafeInteger(cut.gstBp) && cut.gstBp >= 0 && cut.gstBp <= 2_800))
    throw new RangeError("The partner's GST must be 0–28% (whole basis points)");
  await inTransaction(pool, async (c) => {
    // Same lock as the hour close, so the cut is brought in line at once and never posted twice.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('close-earnings'))");
    const r = await c.query<{ trial: boolean; paid: boolean; state: string }>(
      `SELECT b.trial,
              EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.booking_id
                       AND e.state = 'paid') AS paid,
              (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                ORDER BY seq DESC LIMIT 1) AS state
         FROM bookings b WHERE b.booking_id = $1`,
      [cut.bookingId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`No booking ${cut.bookingId}`);
    // Cuts are on delivered plays: only a paid booking that can still deliver can have one.
    if (row.trial) throw new Error('A trial has no cut: nothing is paid');
    if (!row.paid) throw new Error('A cut can only be given on a paid booking');
    if (row.state === 'cancelled' || row.state === 'ads-missing')
      throw new Error(`A ${row.state} booking delivers nothing, so it has no cut`);
    // The rates in force when the cut is given (not when the booking was sold).
    const book = priceBookAt(await priceBooks(c), isoAt(now));
    if (!book) throw new Error('No price book in force');
    const rate = cut.rateBp ?? book.cuts[cut.kind];
    await c.query(
      `INSERT INTO booking_cuts
         (booking_id, kind, partner_id, rate_bp, gst_bp, tds_bp, decided_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [cut.bookingId, cut.kind, cut.partnerId, rate, cut.gstBp, book.cutTdsBp, by.id, reason],
    );
    await accrueCuts(c, cut.bookingId, now, by.id);
  });
}

/** Brings every cut of a booking in line with its delivered revenue (inside the caller's transaction). */
export async function accrueCuts(
  c: PoolClient,
  bookingId: string,
  now: number,
  by: string,
): Promise<number> {
  const cuts = await c.query<{
    kind: Cut['kind'];
    partner_id: string;
    rate_bp: number;
    gst_bp: number;
    tds_bp: number;
  }>('SELECT kind, partner_id, rate_bp, gst_bp, tds_bp FROM booking_cuts WHERE booking_id = $1', [
    bookingId,
  ]);
  if (cuts.rows.length === 0) return 0;
  // Delivered revenue of all the booking's lines (refs "<booking>/<area>/<day>/<hour>"); money kept
  // without delivery (late cancel, refund rejected, ads missing) carries no cut.
  const rev = await c.query<{ n: string }>(
    `SELECT coalesce(sum(p.credit - p.debit), 0) AS n
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE p.account = 'revenue' AND e.kind LIKE 'line-earned%' AND e.ref LIKE $1 || '/%'`,
    [bookingId],
  );
  const earned = Number(rev.rows[0]?.n ?? 0);
  let posted = 0;
  for (const k of cuts.rows) {
    const expense = k.kind === 'agency' ? 'agency-cuts' : 'aggregator-cuts';
    const so = await c.query<{ cut: string; gst: string; tds: string; n: string }>(
      `SELECT coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = $2), 0) AS cut,
              coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = 'gst-input'), 0) AS gst,
              coalesce(sum(p.credit - p.debit) FILTER (WHERE p.account = 'tds-payable'), 0) AS tds,
              count(DISTINCT e.entry_id) AS n
         FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE e.ref = $1 AND e.kind = $3`,
      [bookingId, expense, `${k.kind}-cut`],
    );
    const row = so.rows[0];
    const e = cutAccrued(
      {
        bookingId,
        kind: k.kind,
        partnerId: k.partner_id,
        rateBp: k.rate_bp,
        gstBp: k.gst_bp,
        tdsBp: k.tds_bp,
      },
      earned,
      { cut: Number(row?.cut ?? 0), gst: Number(row?.gst ?? 0), tds: Number(row?.tds ?? 0) },
      Number(row?.n ?? 0) + 1,
      now,
    );
    if (e) {
      await postEntry(c, e, by);
      posted += 1;
    }
  }
  return posted;
}
