import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { trialBalance } from '../../src/ledger.js';
import {
  moveScreenLoan,
  recordScreenLoan,
  riderLoanPage,
  riderLoans,
} from '../../src/screen-loans.js';
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

  it("the rider app's loan page (P4.7): the EMI holiday, the next EMI, the day-90 bonus", async () => {
    const dec = Date.parse('2027-12-10T06:00:00Z') / 1000;
    let p = await riderLoanPage(pool, 'R-AAA', dec, 'Dhanlaxmi Bank');
    expect(p.loan).toMatchObject({
      loanId: 'LN-0001',
      amountPaise: 3_100_000,
      emiPaise: 137_000,
      status: 'disbursed',
      nextEmi: '2028-02-05',
      emisLeft: 36,
      holidayUntil: '2028-02-05',
    });
    expect(p.loan?.disbursedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // No POC ever switched on: no day-90 bonus.
    expect(p.day90).toBeNull();
    p = await riderLoanPage(pool, 'R-AAA', Date.parse('2028-02-10T06:00:00Z') / 1000, 'X');
    expect(p.loan).toMatchObject({ holidayUntil: null, nextEmi: '2028-03-05', emisLeft: 35 });
    expect((await riderLoanPage(pool, 'R-NONE', dec, 'Dhanlaxmi Bank')).loan).toBeNull();
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
