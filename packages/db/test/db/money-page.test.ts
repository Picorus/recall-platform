// P3.13.1: money as finance sees it: a month's payments received (paid, and paid after a
// cancellation, owed back), its tax invoices, where money stands, and unknown provider messages.
import { fakePayments } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1, type BookingLine } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { cancelBooking, paymentMessage, sendForPayment } from '../../src/booking-desk.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { setBrandTaxProfile } from '../../src/gst.js';
import { trialBalance } from '../../src/ledger.js';
import {
  gstDocuments,
  indiaMonth,
  moneyPosition,
  paymentsIn,
  unknownPayments,
} from '../../src/money.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const payments = fakePayments({ clock: () => NOW });
const line = (date: string, startHour: number): BookingLine => ({
  areaId: 'hyd-madhapur',
  date,
  startHour,
  bikes: 30,
});
const draft = (bookingId: string, lines: BookingLine[]) =>
  createBooking(
    pool,
    {
      bookingId,
      brandId: 'chai-co',
      request: { lines, repeatMonths: 1, channel: 'admin' },
      by: 'Sana',
    },
    NOW,
  );

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await setBrandTaxProfile(
    pool,
    'chai-co',
    { legalName: 'Chai Co Pvt Ltd', gstin: '36AAPFU0939F1ZW', stateCode: '36' },
    'Sana',
  );
  // One booking paid; one paid after it was cancelled (owed back).
  await draft('BK-M-1', [line('2027-08-27', 19), line('2027-08-27', 20)]);
  const a = await sendForPayment(pool, payments, 'BK-M-1', 'Sana', NOW);
  const msg = payments.pay(a.linkId);
  await paymentMessage(pool, payments, msg.body, msg.signature, NOW + 600);
  await draft('BK-M-2', [line('2027-08-28', 19), line('2027-08-28', 20)]);
  const b = await sendForPayment(pool, payments, 'BK-M-2', 'Sana', NOW + 700);
  payments.pay(b.linkId);
  await cancelBooking(pool, payments, 'BK-M-2', 'Sana', 'client changed plans', NOW + 800);
  // A signed message about a link we never made.
  await pool.query(
    `INSERT INTO payment_inbox (link_id, payment_id, event, received_at)
     VALUES ('lnk_stranger', 'pay_stranger', '{}', to_timestamp($1))`,
    [NOW + 900],
  );
}, 60_000);
afterAll(async () => db.drop());

describe('money as finance sees it (P3.13.1)', () => {
  it('a month is India time', () => {
    expect(indiaMonth('2027-08')).toEqual({
      from: Date.UTC(2027, 6, 31, 18, 30) / 1000,
      to: Date.UTC(2027, 7, 31, 18, 30) / 1000,
    });
    expect(() => indiaMonth('2027-13')).toThrow('YYYY-MM');
  });

  it('payments received in the month, newest first; late money marked', async () => {
    const { payments: got, truncated } = await paymentsIn(pool, '2027-08');
    expect(truncated).toBe(false);
    expect(got.map((p) => [p.bookingId, p.state, p.amountPaise])).toEqual([
      ['BK-M-2', 'paid-late', 2_124_000],
      ['BK-M-1', 'paid', 2_124_000],
    ]);
    expect(got[1]?.brandName).toBe('chai-co'); // no brand record: its id
    expect((await paymentsIn(pool, '2027-07')).payments).toEqual([]);
  });

  it('the tax invoice issued for the paid booking', async () => {
    const { documents } = await gstDocuments(pool, '2027-08');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      kind: 'invoice',
      bookingId: 'BK-M-1',
      legalName: 'Chai Co Pvt Ltd',
      gstin: '36AAPFU0939F1ZW',
      taxablePaise: 1_800_000,
      gstPaise: 324_000,
      totalPaise: 2_124_000,
    });
  });

  it('where money stands: held for the campaign, owed back, GST', async () => {
    expect(await moneyPosition(pool)).toEqual({
      heldForCampaignsPaise: 1_800_000,
      owedBack: [{ brandId: 'chai-co', brandName: 'chai-co', paise: 2_124_000 }],
      owedToAgenciesPaise: 0,
      owedToAggregatorsPaise: 0,
      owedToRidersPaise: 0,
      tdsPaise: 0,
      gstPaise: 324_000,
    });
    expect(await unknownPayments(pool)).toEqual([
      { linkId: 'lnk_stranger', paymentId: 'pay_stranger', receivedAt: NOW + 900 },
    ]);
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
