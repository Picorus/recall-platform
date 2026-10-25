import { fakePayouts } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import {
  approvePayoutRun,
  checkDestination,
  payoutRunStatus,
  preparePayoutRun,
  sendPayoutRun,
  setPayoutAccount,
} from '../../src/payouts.js';
import { assignScreen, monthBounds } from '../../src/rider-pay.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const FINANCE = { id: 'meena', role: 'finance' } as const;
/** India time, as UTC seconds. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const upi = (rider: string) => ({
  kind: 'upi' as const,
  vpa: `${rider.toLowerCase()}@okbank`,
  name: rider,
});

const owed = async (rider: string) => {
  const t = await accountTotals(pool, 'rider-payable', { party: rider });
  return t.credit - t.debit;
};

/** POC month 1 (August 2027): ₹2,000 over 31 days, day 1 to day `d`, less 1% TDS. */
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
  for (const r of ['R-AAA', 'R-BBB', 'R-CCC', 'R-DDD'])
    await assignScreen(pool, `scr-${r}`, r, monthBounds('2027-08').start, 'fitter');
  await setPayoutAccount(pool, 'R-AAA', upi('R-AAA'), 'priya');
  await setPayoutAccount(pool, 'R-BBB', upi('R-BBB'), 'priya');
  await setPayoutAccount(
    pool,
    'R-DDD',
    { kind: 'bank', accountNumber: '123456789012', ifsc: 'HDFC0001234', name: 'R-DDD' },
    'priya',
  );
}, 60_000);
afterAll(async () => db.drop());

describe('the Monday payout run (P1.7.7)', () => {
  const MON = '2027-08-09';
  const at = ist('2027-08-09T10:00:00');
  const provider = fakePayouts({
    failFor: new Map([
      ['R-BBB', { reason: 'bank server down', retryable: true, times: 1 }],
      ['R-DDD', { reason: 'account closed', retryable: false, times: 1 }],
    ]),
  });

  it('is prepared only on its Monday', async () => {
    await expect(preparePayoutRun(pool, '2027-08-10', at)).rejects.toThrow(/not a Monday/);
    await expect(preparePayoutRun(pool, MON, ist('2027-08-08T22:00:00'))).rejects.toThrow(
      /not before/,
    );
  });

  it('lists what each rider is owed for the week; a rider with no account is shown, not paid', async () => {
    const run = await preparePayoutRun(pool, MON, at);
    // 1–8 August have ended: 8 days of the ₹2,000 base, less TDS.
    expect(run.lines).toEqual([
      { riderId: 'R-AAA', amountPaise: netFor(8) },
      { riderId: 'R-BBB', amountPaise: netFor(8) },
      { riderId: 'R-DDD', amountPaise: netFor(8) },
    ]);
    expect(run.noAccount).toEqual([{ riderId: 'R-CCC', owedPaise: netFor(8) }]);
    await expect(preparePayoutRun(pool, MON, at)).rejects.toThrow(/already prepared/);
  });

  it('nothing is paid until finance approves; only finance or a super admin can', async () => {
    await expect(sendPayoutRun(pool, MON, provider, at)).rejects.toThrow(/not approved/);
    await expect(approvePayoutRun(pool, MON, { id: 'priya', role: 'admin' }, at)).rejects.toThrow(
      /finance/,
    );
    await approvePayoutRun(pool, MON, FINANCE, at);
    await expect(approvePayoutRun(pool, MON, SUPER, at)).rejects.toThrow(/already approved/);
    expect(provider.sent).toHaveLength(0);
  });

  it('pays each rider; a passing failure is retried; a wrong account is given up and shown', async () => {
    const first = await sendPayoutRun(pool, MON, provider, at + 60);
    expect(first.paid).toEqual(['R-AAA']);
    expect(first.failed).toEqual([{ riderId: 'R-BBB', reason: 'bank server down' }]);
    expect(first.givenUp).toEqual([{ riderId: 'R-DDD', reason: 'account closed' }]);
    expect(await owed('R-AAA')).toBe(0);
    const again = await sendPayoutRun(pool, MON, provider, at + 3600);
    expect(again.paid).toEqual(['R-BBB']);
    // Sent again: nothing new (R-AAA and R-BBB paid, R-DDD given up).
    const third = await sendPayoutRun(pool, MON, provider, at + 7200);
    expect([third.paid, third.failed, third.givenUp]).toEqual([[], [], []]);
    expect(provider.sent.filter((s) => s.riderId === 'R-AAA')).toHaveLength(1);
    const status = new Map((await payoutRunStatus(pool, MON)).map((s) => [s.riderId, s]));
    expect(status.get('R-BBB')).toMatchObject({ status: 'paid', tries: 2 });
    expect(status.get('R-DDD')).toMatchObject({ status: 'given up', reason: 'account closed' });
    // The money paid left the bank; what was not paid is still owed.
    const bank = await accountTotals(pool, 'bank');
    expect(bank.credit - bank.debit).toBe(2 * netFor(8));
    expect(await owed('R-DDD')).toBe(netFor(8));
  });

  it('next Monday: the new week, plus what was not paid (a given-up payout, a new account)', async () => {
    await setPayoutAccount(pool, 'R-CCC', upi('R-CCC'), 'priya');
    const run = await preparePayoutRun(pool, '2027-08-16', ist('2027-08-16T10:00:00'));
    const week = netFor(15) - netFor(8); // days 9–15 (TDS rounding on the running total)
    expect(run.lines).toEqual([
      { riderId: 'R-AAA', amountPaise: week },
      { riderId: 'R-BBB', amountPaise: week },
      { riderId: 'R-CCC', amountPaise: netFor(15) },
      { riderId: 'R-DDD', amountPaise: netFor(15) },
    ]);
    expect(run.noAccount).toEqual([]);
  });

  it('a run prepared but not yet paid is never paid again by the next run', async () => {
    const run = await preparePayoutRun(pool, '2027-08-23', ist('2027-08-23T10:00:00'));
    const week = netFor(22) - netFor(15);
    // The 16 Aug run is not approved yet: its amounts are not listed again.
    expect(run.lines.map((l) => l.amountPaise)).toEqual([week, week, week, week]);
  });

  it('the whole ledger balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});

describe('payout accounts', () => {
  it('bank and UPI details are checked before they are saved', () => {
    expect(checkDestination(upi('R-AAA'))).toEqual([]);
    expect(
      checkDestination({ kind: 'bank', accountNumber: '12AB', ifsc: 'HDFC1234', name: 'A' }),
    ).toEqual([
      'name of the account holder is needed',
      'account number must be 9–18 digits',
      'IFSC must look like ABCD0123456',
    ]);
    expect(checkDestination({ kind: 'upi', vpa: 'no-at-sign', name: 'Ravi' })).toEqual([
      'UPI id must look like name@bank',
    ]);
  });
});
