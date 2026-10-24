import { bookingPaid, reversal } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { accountTotals, LedgerError, post, trialBalance } from '../../src/ledger.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const T = 1_850_000_000;
const paid = bookingPaid({
  bookingId: 'BK-1',
  brandId: 'brand-1',
  subtotal: 150_000,
  gst: 27_000,
  paymentId: 'pay-1',
  at: T,
});

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

/** Runs SQL as the app role inside one transaction. */
async function asApp(sql: (c: pg.PoolClient) => Promise<unknown>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    await sql(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('the ledger in the database (P1.7.1)', () => {
  it('posts a balanced entry; balances are summed from the postings', async () => {
    expect(await post(pool, paid, 'gateway')).toBe('posted');
    expect(await accountTotals(pool, 'payment-clearing')).toEqual({ debit: 177_000, credit: 0 });
    expect(await accountTotals(pool, 'campaign-held', { party: 'brand-1' })).toEqual({
      debit: 0,
      credit: 150_000,
    });
  });

  it('the same event posted again changes nothing; posted differently, it is refused', async () => {
    expect(await post(pool, paid, 'gateway')).toBe('already');
    await expect(
      post(pool, { ...paid, postings: paid.postings.map((p) => ({ ...p })).reverse() }, 'gateway'),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(await accountTotals(pool, 'payment-clearing')).toEqual({ debit: 177_000, credit: 0 });
  });

  it('the app cannot write ledger rows directly, so postings can never be added to an entry later', async () => {
    await expect(
      asApp((c) =>
        c.query(
          `INSERT INTO ledger_postings (entry_id, n, account, debit, credit)
           VALUES ('paid:BK-1:pay-1', 9, 'bank', 999999, 0), ('paid:BK-1:pay-1', 10, 'revenue', 0, 999999)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('the database itself refuses an entry that does not balance', async () => {
    await expect(
      asApp((c) =>
        c.query(
          `SELECT ledger_post('bad', to_timestamp(${T}), 'manual-adjustment', 'r', 'm', NULL, 'x',
             '[{"account":"bank","debit":"100","credit":"0"},{"account":"revenue","debit":"0","credit":"99"}]')`,
        ),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it("entries made by the system are not reversed by hand; a person's adjustment can be, once, and only exactly", async () => {
    await expect(post(pool, reversal(paid, T + 60, 'oops'), 'prateek')).rejects.toThrow(
      /put right by the system/,
    );
    const adj = {
      entryId: 'adj-1',
      at: T,
      kind: 'manual-adjustment',
      ref: 'BK-1',
      memo: 'gateway fee',
      postings: [
        { account: 'gateway-fees' as const, debit: 354, credit: 0 },
        { account: 'payment-clearing' as const, debit: 0, credit: 354 },
      ],
    };
    await post(pool, adj, 'priya');
    // A "reversal" that does not mirror the entry is refused by the database.
    await expect(
      asApp((c) =>
        c.query(
          `SELECT ledger_post('adj-1~fake', to_timestamp(${T}), 'x', 'BK-1', 'm', 'adj-1', 'x',
             '[{"account":"bank","debit":"1","credit":"0"},{"account":"revenue","debit":"0","credit":"1"}]')`,
        ),
      ),
    ).rejects.toThrow(/does not mirror/);
    await post(pool, reversal(adj, T + 60, 'typed the wrong amount'), 'priya');
    expect(await accountTotals(pool, 'gateway-fees')).toEqual({ debit: 354, credit: 354 });
    await expect(
      post(pool, { ...reversal(adj, T + 120, 'again'), entryId: 'another-reversal' }, 'priya'),
    ).rejects.toThrow();
    await expect(pool.query(`UPDATE ledger_postings SET debit = 1`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow();
  });

  it('the whole ledger always balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
