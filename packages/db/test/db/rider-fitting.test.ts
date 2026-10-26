// P3.11.3: fitting slots (approved riders, one booking each, never past a slot's room), a rider's
// money as staff see it, and what stands open if he leaves.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { post } from '../../src/ledger.js';
import {
  bookFitting,
  cancelFitting,
  fittingSlots,
  leavingChecklist,
  openFittingSlot,
  riderFitting,
  riderMoney,
} from '../../src/rider-fitting.js';
import { createRider } from '../../src/riders.js';
import { moveScreenLoan, recordScreenLoan } from '../../src/screen-loans.js';
import { approvedRider, checkedPayoutAccount, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 5, 1, 6, 30) / 1000;

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await approvedRider(pool, 'RD-000501', 'TS01AA0501');
  await approvedRider(pool, 'RD-000502', 'TS01AA0502');
  await approvedRider(pool, 'RD-000503', 'TS01AA0503');
}, 120_000);
afterAll(async () => db.drop());

describe('fitting slots and leaving (P3.11.3)', () => {
  it('slots take approved riders, one booking each, never past their room', async () => {
    await expect(
      openFittingSlot(
        pool,
        { centre: 'Kukatpally', startsAt: NOW - 60, minutes: 60, bikes: 2, by: 'Omar' },
        NOW,
      ),
    ).rejects.toThrow('A slot starts in the future');
    const a = await openFittingSlot(
      pool,
      {
        centre: 'Kukatpally warehouse',
        startsAt: NOW + 86_400,
        minutes: 120,
        bikes: 2,
        by: 'Omar',
      },
      NOW,
    );
    const b = await openFittingSlot(
      pool,
      {
        centre: 'Kukatpally warehouse',
        startsAt: NOW + 2 * 86_400,
        minutes: 120,
        bikes: 5,
        by: 'Omar',
      },
      NOW,
    );
    await bookFitting(pool, 'RD-000501', a, 'Omar', NOW);
    await bookFitting(pool, 'RD-000501', a, 'Omar', NOW); // again: nothing changes
    await bookFitting(pool, 'RD-000502', a, 'Omar', NOW);
    await expect(bookFitting(pool, 'RD-000503', a, 'Omar', NOW)).rejects.toThrow('is full');
    // Moving RD-000502 to the later slot frees a place.
    await bookFitting(pool, 'RD-000502', b, 'Omar', NOW + 10);
    await bookFitting(pool, 'RD-000503', a, 'Omar', NOW + 20);
    expect((await fittingSlots(pool, NOW)).map((s) => [s.slotId, s.booked])).toEqual([
      [a, ['RD-000501', 'RD-000503']],
      [b, ['RD-000502']],
    ]);
    await cancelFitting(pool, 'RD-000503', 'his bike is in repair', 'Omar', NOW + 30);
    expect((await riderFitting(pool, 'RD-000503', NOW + 40)).booking).toBeNull();
    expect((await riderFitting(pool, 'RD-000501', NOW + 40)).booking?.slotId).toBe(a);
    await expect(cancelFitting(pool, 'RD-000503', 'again', 'Omar', NOW + 50)).rejects.toThrow(
      'no fitting booked',
    );
    // Only approved riders; never a slot that has started.
    const fresh = await createRider(
      pool,
      {
        details: {
          name: 'New Rider',
          phone: '+919888800501',
          bikePlate: null,
          rides: '',
          apps: [],
        },
        channel: 'app',
        by: 'app',
        reason: 'signed up',
      },
      NOW,
    );
    await expect(bookFitting(pool, fresh, b, 'Omar', NOW)).rejects.toThrow(`${fresh} is applied`);
    await expect(bookFitting(pool, 'RD-000503', a, 'Omar', NOW + 86_400 + 60)).rejects.toThrow(
      'This slot has started',
    );
    await expect(pool.query('UPDATE fitting_bookings SET reason = $1', ['x'])).rejects.toThrow();
  });

  it('his money and what stands open if he leaves', async () => {
    const id = 'RD-000501';
    expect(await riderMoney(pool, id)).toEqual({ owedPaise: 0, payouts: [] });
    expect((await leavingChecklist(pool, id, 'SCR-TEST')).filter((c) => !c.done)).toMatchObject([
      { item: 'Screen returned' },
    ]);
    // ₹2,000 of pay owed, no checked account yet, and a loan the bank paid out.
    await post(
      pool,
      {
        entryId: 'test-pay-RD-000501',
        at: NOW,
        kind: 'rider-pay',
        ref: id,
        memo: 'test',
        postings: [
          { account: 'rider-earnings', debit: 200_000, credit: 0 },
          { account: 'rider-payable', debit: 0, credit: 200_000, party: id },
        ],
      },
      'test',
    );
    await recordScreenLoan(
      pool,
      {
        loanId: 'LN-0501',
        riderId: id,
        bank: 'Dhanlaxmi Bank',
        amountPaise: 3_000_000,
        emiPaise: 137_000,
        months: 24,
        firstEmi: '2027-07-05',
      },
      'Omar',
    );
    await moveScreenLoan(pool, 'LN-0501', 'approved', 'bank');
    await moveScreenLoan(pool, 'LN-0501', 'disbursed', 'bank');
    expect((await riderMoney(pool, id)).owedPaise).toBe(200_000);
    expect(await leavingChecklist(pool, id, null)).toEqual([
      { item: 'Screen returned', done: true, detail: 'no screen on his bike' },
      {
        item: 'Final pay',
        done: false,
        detail: '₹2,000 owed but no checked account: check his bank first',
      },
      {
        item: 'Screen loan',
        done: false,
        detail: 'open with Dhanlaxmi Bank: tell the bank he is leaving',
      },
    ]);
    await checkedPayoutAccount(pool, id, { kind: 'upi', vpa: 'test@okaxis', name: 'Test Rider' });
    expect((await leavingChecklist(pool, id, null))[1]).toEqual({
      item: 'Final pay',
      done: true,
      detail: '₹2,000 owed: paid in the next Monday run to UPI test@okaxis · Test Rider',
    });
  });
});
