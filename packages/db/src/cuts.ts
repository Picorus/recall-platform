// P1.7.4 in the database: giving a cut on a booking (only when RECALL decides) and keeping each cut
// in line with what the booking has earned.
import { cutAccrued, type Cut } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';

/**
 * Records that RECALL gives a cut on a booking (Prateek, 24 Oct 2026: never automatic). Decided once
 * per kind per booking. The rate defaults to the price book's (agency 10%, aggregator 2%).
 */
export async function giveCut(
  pool: Pool,
  cut: Omit<Cut, 'rateBp'> & { readonly rateBp?: number },
  by: { readonly id: string; readonly role: string },
  reason: string,
): Promise<void> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can give a cut');
  await inTransaction(pool, async (c) => {
    const r = await c.query<{ rate: number | null }>(
      `SELECT (p.book -> 'cuts' ->> $2)::int AS rate
         FROM bookings b JOIN price_books p ON p.version = b.price_book_version
        WHERE b.booking_id = $1`,
      [cut.bookingId, cut.kind],
    );
    if (!r.rows[0]) throw new Error(`No booking ${cut.bookingId}`);
    const rate = cut.rateBp ?? r.rows[0].rate ?? (cut.kind === 'agency' ? 1_000 : 200);
    await c.query(
      `INSERT INTO booking_cuts (booking_id, kind, partner_id, rate_bp, gst_bp, decided_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cut.bookingId, cut.kind, cut.partnerId, rate, cut.gstBp, by.id, reason],
    );
  });
}

/** Brings every cut of a booking in line with its revenue (inside the caller's transaction). */
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
  }>('SELECT kind, partner_id, rate_bp, gst_bp FROM booking_cuts WHERE booking_id = $1', [
    bookingId,
  ]);
  if (cuts.rows.length === 0) return 0;
  // Revenue of all the booking's lines (their refs are "<booking>/<area>/<day>/<hour>").
  const rev = await c.query<{ n: string }>(
    `SELECT coalesce(sum(p.credit - p.debit), 0) AS n
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE p.account = 'revenue' AND e.ref LIKE $1 || '/%'`,
    [bookingId],
  );
  const earned = Number(rev.rows[0]?.n ?? 0);
  let posted = 0;
  for (const k of cuts.rows) {
    const expense = k.kind === 'agency' ? 'agency-cuts' : 'aggregator-cuts';
    const so = await c.query<{ cut: string; gst: string; n: string }>(
      `SELECT coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = $2), 0) AS cut,
              coalesce(sum(p.debit - p.credit) FILTER (WHERE p.account = 'gst-input'), 0) AS gst,
              count(DISTINCT e.entry_id) AS n
         FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE e.ref = $1 AND e.kind = $3`,
      [bookingId, expense, `${k.kind}-cut`],
    );
    const row = so.rows[0];
    const e = cutAccrued(
      { bookingId, kind: k.kind, partnerId: k.partner_id, rateBp: k.rate_bp, gstBp: k.gst_bp },
      earned,
      { cut: Number(row?.cut ?? 0), gst: Number(row?.gst ?? 0) },
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
