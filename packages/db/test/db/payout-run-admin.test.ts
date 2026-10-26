// P3.12: the payout run in admin: prepared by itself on Monday from 10:00 (India time), findings kept
// with the run, a line held (never sent) and released, a failed line dropped (its money in the next
// run), nothing changed while a run is being sent, and each run as admin shows it.
import { fakePayouts } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import {
  approvePayoutRun,
  dropPayoutLine,
  holdPayoutLine,
  payoutRunDue,
  payoutRunPage,
  payoutRuns,
  prepareDueRun,
  preparePayoutRun,
  sendPayoutRun,
} from '../../src/payouts.js';
import { assignScreen, monthBounds } from '../../src/rider-pay.js';
import { checkedPayoutAccount, freshDatabase } from './fresh-db.js';

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
const netFor = (d: number) => {
  const gross = Math.floor((200_000 * d) / 31);
  return gross - Math.floor((gross * 100 + 5_000) / 10_000);
};
const owed = async (rider: string) => {
  const t = await accountTotals(pool, 'rider-payable', { party: rider });
  return t.credit - t.debit;
};
const MON = '2027-08-09';
const at = ist('2027-08-09T10:00:00');

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await setBusinessMode(pool, 'poc', SUPER, 'POC starts', ist('2027-07-20T12:00:00'));
  for (const r of ['RD-000901', 'RD-000902', 'RD-000903', 'RD-000904'])
    await assignScreen(pool, `scr-${r}`, r, monthBounds('2027-08').start, 'fitter');
  await checkedPayoutAccount(pool, 'RD-000901', upi('RD-000901'));
  await checkedPayoutAccount(pool, 'RD-000902', upi('RD-000902'));
  await checkedPayoutAccount(pool, 'RD-000903', {
    kind: 'bank',
    accountNumber: '123456789012',
    ifsc: 'HDFC0001234',
    name: 'RD-000903',
  });
  // RD-000904 has no checked account.
}, 60_000);
afterAll(async () => db.drop());

describe('the payout run in admin (P3.12)', () => {
  const provider = fakePayouts({
    failFor: new Map([['RD-000903', { reason: 'bank server down', retryable: true, times: 5 }]]),
  });

  it('is prepared by itself on Monday from 10:00 India time, once, with what it found', async () => {
    expect(payoutRunDue(ist('2027-08-09T09:59:00'))).toBeNull();
    expect(payoutRunDue(ist('2027-08-10T10:00:00'))).toBeNull(); // a Tuesday
    expect(payoutRunDue(at)).toBe(MON);
    expect(await prepareDueRun(pool, ist('2027-08-09T09:00:00'))).toBeNull();
    const run = await prepareDueRun(pool, at);
    expect(run?.lines.map((l) => l.riderId)).toEqual(['RD-000901', 'RD-000902', 'RD-000903']);
    expect(await prepareDueRun(pool, at + 300)).toBeNull(); // already prepared
    const page = await payoutRunPage(pool, MON);
    expect(page).toMatchObject({
      runId: MON,
      preparedBy: 'system',
      approvedBy: null,
      lines: 3,
      totalPaise: 3 * netFor(8),
      paidPaise: 0,
      states: { waiting: 3 },
      findings: { noAccount: [{ riderId: 'RD-000904', owedPaise: netFor(8) }], payProblems: [] },
    });
    // A bank account is shown with its last 4 digits only.
    expect(page?.rows.find((r) => r.riderId === 'RD-000903')?.to).toBe(
      'Bank ••••9012 · HDFC0001234 · RD-000903',
    );
    expect(await payoutRunPage(pool, '2027-08-02')).toBeNull();
    expect(await payoutRunPage(pool, 'nonsense')).toBeNull();
  });

  it('a held line is never sent until it is released', async () => {
    await expect(
      holdPayoutLine(pool, MON, 'RD-000901', true, { id: 'priya', role: 'admin' }, 'checking'),
    ).rejects.toThrow(/finance/);
    await expect(holdPayoutLine(pool, MON, 'RD-000901', true, FINANCE, 'x', at)).rejects.toThrow(
      /Say why/,
    );
    await expect(
      holdPayoutLine(pool, MON, 'RD-000904', true, FINANCE, 'no line', at),
    ).rejects.toThrow(/has no line/);
    await holdPayoutLine(pool, MON, 'RD-000901', true, FINANCE, 'he says his UPI changed', at);
    await expect(
      holdPayoutLine(pool, MON, 'RD-000901', true, FINANCE, 'again', at),
    ).rejects.toThrow(/already held/);
    await approvePayoutRun(pool, MON, FINANCE, at + 60);
    const first = await sendPayoutRun(pool, MON, provider, at + 120);
    expect(first.held).toEqual(['RD-000901']);
    expect(first.paid).toEqual(['RD-000902']);
    expect(first.failed).toEqual([{ riderId: 'RD-000903', reason: 'bank server down' }]);
    expect(provider.sent.map((s) => s.riderId)).not.toContain('RD-000901');
    const page = await payoutRunPage(pool, MON);
    expect(page?.states).toEqual({ held: 1, paid: 1, failed: 1 });
    expect(page?.rows[0]).toMatchObject({
      riderId: 'RD-000901',
      state: 'held',
      reason: 'he says his UPI changed',
    });
    await holdPayoutLine(pool, MON, 'RD-000901', false, SUPER, 'he confirmed it', at + 180);
    const again = await sendPayoutRun(pool, MON, provider, at + 240);
    expect(again.paid).toEqual(['RD-000901']);
    expect(again.held).toEqual([]);
    expect(await owed('RD-000901')).toBe(0);
    expect((await payoutRunPage(pool, MON))?.rows[0]?.history.map((h) => h.text)).toEqual([
      'held: he says his UPI changed',
      'released: he confirmed it',
      'paid',
    ]);
    // A paid line can be neither held nor dropped.
    await expect(
      holdPayoutLine(pool, MON, 'RD-000901', true, FINANCE, 'too late', at + 300),
    ).rejects.toThrow(/is paid/);
    await expect(
      dropPayoutLine(pool, MON, 'RD-000902', FINANCE, 'too late', at + 300),
    ).rejects.toThrow(/is paid/);
  });

  it('nothing on a run changes while it is being sent', async () => {
    const other = await pool.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext('payout-send'))");
      await expect(
        holdPayoutLine(pool, MON, 'RD-000903', true, FINANCE, 'checking', at + 360),
      ).rejects.toThrow(/being sent/);
      await expect(
        dropPayoutLine(pool, MON, 'RD-000903', FINANCE, 'his bank is down', at + 360),
      ).rejects.toThrow(/being sent/);
    } finally {
      await other.query("SELECT pg_advisory_unlock(hashtext('payout-send'))");
      other.release();
    }
  });

  it('a failed line dropped: never sent again, its money in the next run', async () => {
    const tried = () => provider.sent.filter((s) => s.riderId === 'RD-000903').length;
    expect(tried()).toBe(2); // failed on both sends so far
    await dropPayoutLine(pool, MON, 'RD-000903', FINANCE, 'his bank is down all week', at + 400);
    const later = await sendPayoutRun(pool, MON, provider, at + 500);
    expect([later.paid, later.failed, later.held]).toEqual([[], [], []]);
    expect(tried()).toBe(2);
    expect((await payoutRunPage(pool, MON))?.rows[2]).toMatchObject({
      state: 'cancelled',
      reason: 'dropped by meena: his bank is down all week',
      tries: 2,
    });
    const next = await preparePayoutRun(pool, '2027-08-16', ist('2027-08-16T10:00:00'), 'meena');
    expect(next.lines.find((l) => l.riderId === 'RD-000903')?.amountPaise).toBe(netFor(15));
    // Whoever prepared a run by hand cannot approve it.
    await expect(
      approvePayoutRun(pool, '2027-08-16', FINANCE, ist('2027-08-16T11:00:00')),
    ).rejects.toThrow(/someone else/);
  });

  it('runs are listed newest first with their totals; holds are never edited', async () => {
    const runs = await payoutRuns(pool);
    expect(runs.map((r) => [r.runId, r.lines, r.approvedBy])).toEqual([
      ['2027-08-16', 3, null],
      [MON, 3, 'meena'],
    ]);
    expect(runs[1]).toMatchObject({ paidPaise: 2 * netFor(8), states: { paid: 2, cancelled: 1 } });
    await expect(pool.query('UPDATE payout_holds SET reason = $1', ['x'])).rejects.toThrow();
    await expect(pool.query('DELETE FROM payout_run_findings')).rejects.toThrow();
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
