// P3.13.3: agencies and aggregators: a cut given by a super admin (once per kind and booking), the
// partner's monthly statement (cuts by booking, GST, TDS, payments, invoices, opening and closing),
// and payments recorded by bank transfer, never more than owed.
import { fakePayments } from '@recall/adapters';
import { cutAccrued, launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { paymentMessage, sendForPayment } from '../../src/booking-desk.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { giveCut } from '../../src/cuts.js';
import { recordPartnerInvoice } from '../../src/gst.js';
import { post, trialBalance } from '../../src/ledger.js';
import { partners, partnerStatement, payPartner, statementCsv } from '../../src/partners.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const SEPT = Date.UTC(2027, 8, 6, 4, 30) / 1000; // 6 Sep 2027
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const FINANCE = { id: 'meena', role: 'finance' } as const;
const payments = fakePayments({ clock: () => NOW });
const CUT = {
  bookingId: 'BK-P-1',
  kind: 'agency' as const,
  partnerId: 'adwise',
  rateBp: 1_000,
  gstBp: 1_800,
  tdsBp: 200,
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createBooking(
    pool,
    {
      bookingId: 'BK-P-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    NOW,
  );
  const link = await sendForPayment(pool, payments, 'BK-P-1', 'Sana', NOW);
  const msg = payments.pay(link.linkId);
  await paymentMessage(pool, payments, msg.body, msg.signature, NOW + 60);
}, 60_000);
afterAll(async () => db.drop());

describe('partners (P3.13.3)', () => {
  it('a cut is given once per kind and booking, by a super admin, on a paid booking', async () => {
    const given = {
      bookingId: CUT.bookingId,
      kind: CUT.kind,
      partnerId: CUT.partnerId,
      gstBp: CUT.gstBp,
    };
    await expect(giveCut(pool, given, FINANCE, 'agency deal', NOW + 100)).rejects.toThrow(
      /super admin/,
    );
    await giveCut(pool, given, SUPER, 'agency deal', NOW + 100);
    await expect(giveCut(pool, given, SUPER, 'again', NOW + 110)).rejects.toThrow(/already given/);
    expect(await partners(pool)).toEqual([
      { partnerId: 'adwise', kind: 'agency', name: 'adwise', owedPaise: 0, bookings: 1 },
    ]);
  });

  it('a monthly statement: cuts as plays are delivered, payments, invoices, opening and closing', async () => {
    // ₹18,000 delivered in August: 10% = ₹1,800 with the agency's GST (₹1,525.42 + ₹274.58), less
    // 2% TDS on ₹1,525.42 (₹30.51): ₹1,769.49 owed.
    const aug = cutAccrued(CUT, 1_800_000, { cut: 0, gst: 0, tds: 0 }, 1, NOW + 4 * 86_400);
    if (aug) await post(pool, aug, 'closer');
    const s = await partnerStatement(pool, 'adwise', 'agency', '2027-08');
    expect(s).toMatchObject({
      openingPaise: 0,
      cuts: [
        {
          bookingId: 'BK-P-1',
          cutPaise: 152_542,
          gstPaise: 27_458,
          tdsPaise: 3_051,
          netPaise: 176_949,
        },
      ],
      payments: [],
      closingPaise: 176_949,
    });
    expect(statementCsv(s).name).toBe('statement-agency-adwise-2027-08.csv');
    expect(statementCsv(s).csv).toContain('cut on BK-P-1,1525.42,274.58,30.51,1769.49');
  });

  it('paid by bank transfer, never more than owed; September opens with what is left', async () => {
    await expect(
      payPartner(
        pool,
        {
          partnerId: 'adwise',
          kind: 'agency',
          amountPaise: 176_950,
          reference: 'UTR11112222',
          note: '',
        },
        FINANCE,
        SEPT,
      ),
    ).rejects.toThrow(/owed only ₹1769.49/);
    await expect(
      payPartner(
        pool,
        { partnerId: 'adwise', kind: 'agency', amountPaise: 100_000, reference: '!', note: '' },
        FINANCE,
        SEPT,
      ),
    ).rejects.toThrow(/bank reference/);
    await expect(
      payPartner(
        pool,
        {
          partnerId: 'adwise',
          kind: 'agency',
          amountPaise: 100_000,
          reference: 'UTR11112222',
          note: '',
        },
        { id: 'priya', role: 'admin' },
        SEPT,
      ),
    ).rejects.toThrow(/finance/);
    expect(
      await payPartner(
        pool,
        {
          partnerId: 'adwise',
          kind: 'agency',
          amountPaise: 100_000,
          reference: 'UTR11112222',
          note: 'August, part',
        },
        FINANCE,
        SEPT,
      ),
    ).toBe(1);
    // The same transfer again (a lost reply, a second press): refused.
    await expect(
      payPartner(
        pool,
        {
          partnerId: 'adwise',
          kind: 'agency',
          amountPaise: 100_000,
          reference: 'UTR11112222',
          note: '',
        },
        FINANCE,
        SEPT + 60,
      ),
    ).rejects.toThrow(/already recorded/);
    await recordPartnerInvoice(
      pool,
      {
        partnerId: 'adwise',
        invoiceNo: 'AW/27/031',
        invoiceDate: '2027-09-01',
        taxablePaise: 152_542,
        gstPaise: 0,
      },
      'meena',
    );
    await expect(
      recordPartnerInvoice(
        pool,
        {
          partnerId: 'adwise',
          invoiceNo: 'AW/27/031',
          invoiceDate: '2027-09-01',
          taxablePaise: 1,
          gstPaise: 0,
        },
        'meena',
      ),
    ).rejects.toThrow(/already recorded/);
    const sep = await partnerStatement(pool, 'adwise', 'agency', '2027-09');
    expect(sep).toMatchObject({
      openingPaise: 176_949,
      cuts: [],
      payments: [{ amountPaise: 100_000, reference: 'UTR11112222', by: 'meena' }],
      invoices: [{ invoiceNo: 'AW/27/031', invoiceDate: '2027-09-01', taxablePaise: 152_542 }],
      closingPaise: 76_949,
    });
    expect((await partners(pool))[0]?.owedPaise).toBe(76_949);
    await expect(pool.query('DELETE FROM partner_payments')).rejects.toThrow();
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
