import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { trialBalance } from '../../src/ledger.js';
import { moveScreenLoan, recordScreenLoan, riderLoans } from '../../src/screen-loans.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

const LOAN = {
  loanId: 'LN-0001',
  riderId: 'R-AAA',
  bank: 'Dhanlaxmi Bank',
  amountPaise: 3_100_000,
  emiPaise: 137_000,
  months: 36,
  firstEmi: '2028-02-05',
};

describe('the screen loan record (P1.7.8)', () => {
  it('records a loan and shows its status, next EMI and EMIs left in the rider app', async () => {
    await recordScreenLoan(pool, LOAN, 'priya');
    await moveScreenLoan(pool, 'LN-0001', 'approved', 'priya', 'bank approved');
    await moveScreenLoan(pool, 'LN-0001', 'disbursed', 'priya', 'paid to RECALL as seller');
    const [l] = await riderLoans(pool, 'R-AAA', '2028-02-10');
    expect(l).toMatchObject({ status: 'disbursed', nextEmi: '2028-03-05', emisLeft: 35 });
  });

  it('statuses only move forward', async () => {
    await expect(moveScreenLoan(pool, 'LN-0001', 'approved', 'priya')).rejects.toThrow(
      /disbursed cannot become approved/,
    );
    await expect(moveScreenLoan(pool, 'LN-9999', 'approved', 'priya')).rejects.toThrow(/No screen/);
  });

  it('a loan never touches RECALL’s books', async () => {
    const r = await pool.query('SELECT count(*)::int AS n FROM ledger_entries');
    expect(r.rows[0]).toEqual({ n: 0 });
    expect(await trialBalance(pool)).toEqual({ debit: 0, credit: 0 });
  });
});
