// Found in review (P1.7.7): a run paying more than owed, runs that could not be cancelled, pending
// payouts, a provider that does not answer, and a pool with one connection.
import { fakePayouts, type PayoutsAdapter } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { accountTotals } from '../../src/ledger.js';
import {
  approvePayoutRun,
  cancelPayoutRun,
  payoutRunStatus,
  preparePayoutRun,
  sendPayoutRun,
  setPayoutAccount,
} from '../../src/payouts.js';
import { accrueRiderPay, assignScreen, monthBounds } from '../../src/rider-pay.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const FINANCE = { id: 'meena', role: 'finance' } as const;
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const upi = (rider: string) => ({
  kind: 'upi' as const,
  vpa: `${rider.toLowerCase()}@okbank`,
  name: rider,
});
const RIDERS = ['R-AAA', 'R-BBB', 'R-CCC'];

const owed = async (rider: string) => {
  const t = await accountTotals(pool, 'rider-payable', { party: rider });
  return t.credit - t.debit;
};
/** POC month 1: ₹2,000 over 31 days, days 1 to `d`, less 1% TDS. */
const netFor = (d: number) => {
  const gross = Math.floor((200_000 * d) / 31);
  return gross - Math.floor((gross * 100 + 5_000) / 10_000);
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await setBusinessMode(pool, 'poc', SUPER, 'POC starts', ist('2027-07-20T12:00:00'));
  for (const r of RIDERS) {
    await assignScreen(pool, `scr-${r}`, r, monthBounds('2027-08').start, 'fitter');
    await setPayoutAccount(pool, r, upi(r), 'priya');
  }
}, 60_000);
afterAll(async () => db.drop());

describe('payout run edges', () => {
  it('a line is never paid when the rider is now owed less: it is cancelled and the right amount comes next run', async () => {
    const at = ist('2027-08-09T10:00:00');
    await preparePayoutRun(pool, '2027-08-09', at);
    // A late correction: R-AAA's screen was really taken off on 3 August.
    await assignScreen(pool, 'scr-R-AAA', null, ist('2027-08-03T08:00:00'), 'fitter');
    await accrueRiderPay(pool, '2027-08', at + 60);
    expect(await owed('R-AAA')).toBe(netFor(2));
    await approvePayoutRun(pool, '2027-08-09', FINANCE, at);
    const r = await sendPayoutRun(pool, '2027-08-09', fakePayouts(), at + 120);
    expect(r.paid).toEqual(['R-BBB', 'R-CCC']);
    expect(r.givenUp).toEqual([{ riderId: 'R-AAA', reason: 'owed less than this line now' }]);
    expect(await owed('R-AAA')).toBe(netFor(2)); // never below 0
    const next = await preparePayoutRun(pool, '2027-08-16', ist('2027-08-16T10:00:00'));
    expect(next.lines.find((l) => l.riderId === 'R-AAA')?.amountPaise).toBe(netFor(2));
  });

  it('finance can cancel what is left of a run; its money comes back in the next run', async () => {
    await expect(
      cancelPayoutRun(pool, '2027-08-16', { id: 'priya', role: 'admin' }, 'wrong week'),
    ).rejects.toThrow(/finance/);
    expect(await cancelPayoutRun(pool, '2027-08-16', FINANCE, 'prepared twice by mistake')).toEqual(
      ['R-AAA', 'R-BBB', 'R-CCC'],
    );
    const next = await preparePayoutRun(pool, '2027-08-23', ist('2027-08-23T10:00:00'));
    expect(next.lines.find((l) => l.riderId === 'R-BBB')?.amountPaise).toBe(netFor(22) - netFor(8));
  });

  it('no answer from the provider: recorded as pending, the others are still paid, asked again later', async () => {
    const at = ist('2027-08-23T11:00:00');
    await approvePayoutRun(pool, '2027-08-23', FINANCE, at);
    const flaky: PayoutsAdapter = {
      send: (req) =>
        req.riderId === 'R-BBB'
          ? Promise.reject(new Error('timeout'))
          : Promise.resolve({ status: 'pending', providerRef: `p-${req.riderId}` }),
    };
    // Pending many times is never given up and never counts as a failed try.
    for (let i = 0; i < 5; i += 1) await sendPayoutRun(pool, '2027-08-23', flaky, at + i);
    const status = new Map((await payoutRunStatus(pool, '2027-08-23')).map((s) => [s.riderId, s]));
    expect(status.get('R-BBB')?.status).toBe('pending');
    expect(status.get('R-CCC')?.status).toBe('pending');
    const settled = await sendPayoutRun(pool, '2027-08-23', fakePayouts(), at + 3600);
    expect(settled.paid).toEqual(['R-AAA', 'R-BBB', 'R-CCC']);
  });

  it('works with a pool of one connection', async () => {
    const one = new pg.Pool({ ...pool.options, max: 1 });
    try {
      const at = ist('2027-08-30T10:00:00');
      await preparePayoutRun(one, '2027-08-30', at);
      await approvePayoutRun(one, '2027-08-30', FINANCE, at);
      const r = await sendPayoutRun(one, '2027-08-30', fakePayouts(), at + 60);
      expect(r.paid.length).toBeGreaterThan(0);
    } finally {
      await one.end();
    }
  });

  it('a rider is never owed less than 0', async () => {
    for (const r of RIDERS) expect(await owed(r)).toBeGreaterThanOrEqual(0);
  });
});
