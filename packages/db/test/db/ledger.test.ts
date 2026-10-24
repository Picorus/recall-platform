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

  it('the database itself refuses an entry that does not balance, even written by hand', async () => {
    await expect(
      asApp(async (c) => {
        await c.query(
          `INSERT INTO ledger_entries (entry_id, at, kind, ref, memo, posted_by)
           VALUES ('bad', to_timestamp(${T}), 'k', 'r', 'm', 'x')`,
        );
        await c.query(
          `INSERT INTO ledger_postings (entry_id, n, account, debit, credit)
           VALUES ('bad', 1, 'bank', 100, 0), ('bad', 2, 'revenue', 0, 99)`,
        );
      }),
    ).rejects.toThrow(/does not balance/);
    await expect(
      asApp((c) =>
        c.query(
          `INSERT INTO ledger_entries (entry_id, at, kind, ref, memo, posted_by)
           VALUES ('empty', to_timestamp(${T}), 'k', 'r', 'm', 'x')`,
        ),
      ),
    ).rejects.toThrow(/does not balance/);
  });

  it('a mistake is undone once by a reversing entry; entries cannot be edited or deleted', async () => {
    await post(pool, reversal(paid, T + 60, 'paid twice by mistake'), 'prateek');
    expect(await accountTotals(pool, 'payment-clearing')).toEqual({
      debit: 177_000,
      credit: 177_000,
    });
    await expect(
      post(pool, { ...reversal(paid, T + 120, 'again'), entryId: 'another-reversal' }, 'prateek'),
    ).rejects.toThrow();
    await expect(pool.query(`UPDATE ledger_postings SET debit = 1`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow();
  });

  it('the whole ledger always balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
