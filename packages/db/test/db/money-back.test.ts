// P3.13.2: money owed back to brands goes back once: through the payment provider against the
// brand's payment (a passing failure tried again, a pending answer asked again, never twice), or by
// a bank transfer recorded by hand when the provider cannot; the books move once, with who and how.
import { fakePayments } from '@recall/adapters';
import { launchAreas, moneyToReturn, PRICE_BOOK_V1, refundApproved } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { cancelBooking, paymentMessage, sendForPayment } from '../../src/booking-desk.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { accountTotals, post, trialBalance } from '../../src/ledger.js';
import {
  moneyBackItem,
  moneyOwedBack,
  recordMoneyBackByHand,
  sendMoneyBack,
} from '../../src/money-back.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const FINANCE = { id: 'meena', role: 'finance' } as const;
const fails = new Map<string, { reason: string; retryable: boolean; times?: number }>();
const pending = new Set<string>();
const payments = fakePayments({ clock: () => NOW, refundFails: fails, refundPending: pending });
let pay1 = '';
let pay2 = '';

const book = async (bookingId: string, date: string, at: number) => {
  await createBooking(
    pool,
    {
      bookingId,
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date, startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date, startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    at,
  );
  const link = await sendForPayment(pool, payments, bookingId, 'Sana', at);
  return link.linkId;
};
const owedBack = async () => {
  const t = await accountTotals(pool, 'refunds-payable', { party: 'chai-co' });
  return t.credit - t.debit;
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  // BK-R-1 paid; then a refund of ₹5,900 approved on one of its lines.
  const l1 = await book('BK-R-1', '2027-08-27', NOW);
  const m1 = payments.pay(l1);
  await paymentMessage(pool, payments, m1.body, m1.signature, NOW + 60);
  pay1 = `pay_fake_${l1.slice(6)}`;
  await post(
    pool,
    refundApproved({
      refundId: 'BK-R-1/hyd-madhapur/2027-08-27/19#refund',
      lineId: 'BK-R-1/hyd-madhapur/2027-08-27/19',
      brandId: 'chai-co',
      base: 500_000,
      gst: 90_000,
      at: NOW + 300,
    }),
    'prateek',
  );
  // BK-R-2 paid after it was cancelled: all ₹21,240 owed back.
  const l2 = await book('BK-R-2', '2027-08-28', NOW + 100);
  payments.pay(l2);
  await cancelBooking(pool, payments, 'BK-R-2', 'Sana', 'client changed plans', NOW + 200);
  pay2 = `pay_fake_${l2.slice(6)}`;
  // A payment for a link we never knew: no brand, and the provider cannot send it back.
  await post(
    pool,
    moneyToReturn({
      paymentId: 'pay_stray',
      ref: 'lnk_stray',
      amount: 100_000,
      why: 'unknown link',
      at: NOW + 400,
    }),
    'payments',
  );
}, 60_000);
afterAll(async () => db.drop());

describe('money owed back (P3.13.2)', () => {
  it('lists what is owed back, oldest first, with the payment it goes back against', async () => {
    const list = await moneyOwedBack(pool);
    expect(
      list.map((i) => [i.owedEntry, i.kind, i.bookingId, i.amountPaise, i.paymentId, i.state]),
    ).toEqual([
      [`to-return:${pay2}`, 'payment back', 'BK-R-2', 2_124_000, pay2, 'owed'],
      [
        'refund:BK-R-1/hyd-madhapur/2027-08-27/19#refund',
        'refund',
        'BK-R-1',
        590_000,
        pay1,
        'owed',
      ],
      ['to-return:pay_stray', 'payment back', null, 100_000, 'pay_stray', 'owed'],
    ]);
    expect(await owedBack()).toBe(2_714_000);
  });

  it('only finance or a super admin; sent back once through the provider', async () => {
    const id = 'refund:BK-R-1/hyd-madhapur/2027-08-27/19#refund';
    await expect(
      sendMoneyBack(pool, id, payments, { id: 'priya', role: 'admin' }, NOW + 500),
    ).rejects.toThrow(/finance/);
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 500)).toBe('refunded');
    await expect(sendMoneyBack(pool, id, payments, FINANCE, NOW + 510)).rejects.toThrow(
      /already sent back/,
    );
    await expect(
      recordMoneyBackByHand(pool, id, { reference: 'UTR123456', note: '' }, FINANCE, NOW + 520),
    ).rejects.toThrow(/already sent back/);
    expect(payments.refunds.filter((r) => r.paymentId === pay1)).toHaveLength(1);
    expect(payments.refunds[0]).toMatchObject({ paymentId: pay1, amountPaise: 590_000 });
    // A short key for the provider, never the entry itself.
    expect(payments.refunds[0]?.refundKey).toMatch(/^mb_[0-9a-f]{32}$/);
    expect(await owedBack()).toBe(2_124_000);
    expect((await moneyBackItem(pool, id))?.history.map((h) => [h.by, h.text])).toEqual([
      ['meena', 'pending: asked the provider'],
      ['meena', 'refunded'],
    ]);
  });

  it('a passing failure is tried again; a pending answer is asked again, never paid by hand meanwhile', async () => {
    const id = `to-return:${pay2}`;
    fails.set(pay2, { reason: 'bank down', retryable: true, times: 1 });
    pending.add(pay2);
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 600)).toBe('failed');
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 700)).toBe('pending');
    await expect(
      recordMoneyBackByHand(pool, id, { reference: 'UTR999999', note: '' }, FINANCE, NOW + 750),
    ).rejects.toThrow(/may still send/);
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 800)).toBe('refunded');
    expect(await owedBack()).toBe(0);
    // A new key after the failure (a provider replays a failure under its key), then the same key
    // while pending.
    const keys = payments.refunds.filter((r) => r.paymentId === pay2).map((r) => r.refundKey);
    expect(keys).toHaveLength(3);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    const item = await moneyBackItem(pool, id);
    expect([item?.state, item?.tries]).toEqual(['refunded', 3]);
  });

  it('when the provider cannot, it is given up and paid by bank transfer, recorded once', async () => {
    const id = 'to-return:pay_stray';
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 900)).toBe('given up');
    await expect(sendMoneyBack(pool, id, payments, FINANCE, NOW + 910)).rejects.toThrow(
      /bank transfer/,
    );
    await expect(
      recordMoneyBackByHand(pool, id, { reference: 'x', note: '' }, FINANCE, NOW + 920),
    ).rejects.toThrow(/bank reference/);
    await recordMoneyBackByHand(
      pool,
      id,
      { reference: 'HDFCR52027082312345', note: 'sent to the account on their letter' },
      FINANCE,
      NOW + 930,
    );
    expect((await moneyBackItem(pool, id))?.state).toBe('by-hand');
    await expect(
      recordMoneyBackByHand(
        pool,
        id,
        { reference: 'HDFCR5202708239', note: '' },
        FINANCE,
        NOW + 940,
      ),
    ).rejects.toThrow(/already sent back/);
    expect(await moneyOwedBack(pool)).toEqual([]);
    const bank = await accountTotals(pool, 'bank');
    expect(bank.credit - bank.debit).toBe(100_000);
    await expect(pool.query('DELETE FROM money_back_attempts')).rejects.toThrow();
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
    await expect(sendMoneyBack(pool, 'refund:nothing', payments, FINANCE, NOW)).rejects.toThrow(
      /Nothing owed back/,
    );
  });

  it('an answer lost after the provider was asked is never paid by hand by finance', async () => {
    // A refund owed on BK-R-1 again; the provider takes the money back but the answer is lost.
    await post(
      pool,
      refundApproved({
        refundId: 'BK-R-1/hyd-madhapur/2027-08-27/20#refund',
        lineId: 'BK-R-1/hyd-madhapur/2027-08-27/20',
        brandId: 'chai-co',
        base: 100_000,
        gst: 18_000,
        at: NOW + 1000,
      }),
      'prateek',
    );
    const id = 'refund:BK-R-1/hyd-madhapur/2027-08-27/20#refund';
    const lost = {
      ...payments,
      refund: async (r: Parameters<typeof payments.refund>[0]) => {
        await payments.refund(r);
        throw new Error('connection reset');
      },
    };
    expect(await sendMoneyBack(pool, id, lost, FINANCE, NOW + 1100)).toBe('pending');
    await expect(
      recordMoneyBackByHand(pool, id, { reference: 'UTR777777', note: '' }, FINANCE, NOW + 1200),
    ).rejects.toThrow(/may still send/);
    // A super admin may, only saying they checked with the provider.
    await expect(
      recordMoneyBackByHand(
        pool,
        id,
        { reference: 'UTR777777', note: '' },
        { id: 'prateek', role: 'super-admin' },
        NOW + 1200,
      ),
    ).rejects.toThrow(/may still send/);
    // Asking again with the same key finds it was sent back: on the books once.
    expect(await sendMoneyBack(pool, id, payments, FINANCE, NOW + 1300)).toBe('refunded');
    expect(payments.refunds.filter((r) => r.paymentId === pay1).map((r) => r.amountPaise)).toEqual([
      590_000, 118_000, 118_000,
    ]);
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
