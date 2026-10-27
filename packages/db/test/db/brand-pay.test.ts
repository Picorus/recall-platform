// P5.6: review and pay on the portal: the booking line by line with GST split as invoiced; the five
// rules agreed (kept once, with their version); the payment link (the same one asked again); a
// draft that can no longer start in the lead days refused; paid: the bikes kept and the invoice made.
import { fakePayments } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1, TERMS_VERSION, type PortalPlan } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { bookFromPortal } from '../../src/brand-booking.js';
import { portalCampaigns } from '../../src/brand-campaigns.js';
import { askSalesForDeal, payFromPortal, reviewPage } from '../../src/brand-pay.js';
import { applyLinkStatus } from '../../src/booking-desk.js';
import { createAccount } from '../../src/brands.js';
import { savePriceBook } from '../../src/bookings.js';
import { setBrandTaxProfile } from '../../src/gst.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const payments = fakePayments();
const plan: PortalPlan = {
  areaIds: ['hyd-madhapur'],
  hours: [19, 20],
  weekdays: [5],
  startDate: '2027-09-08',
  weeks: 1,
  bikes: 30,
  repeatMonths: 1,
};
const who = { by: 'portal:+919848011111', ip: '10.0.0.1', termsVersion: TERMS_VERSION };

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await createAccount(
    pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'first call',
    },
    NOW - 86_400,
  );
  await setBrandTaxProfile(
    pool,
    'chai-co',
    { legalName: 'Chai Co Pvt Ltd', gstin: '36AAPFU0939F1ZW', stateCode: '36' },
    'Sana',
  );
}, 120_000);
afterAll(async () => db.drop());

describe('review and pay (P5.6)', () => {
  it('line by line, GST split as invoiced, the five rules', async () => {
    const id = await bookFromPortal(pool, { brandId: 'chai-co', plan, by: who.by }, NOW);
    const r = await reviewPage(pool, 'chai-co', id, NOW);
    expect(r).toMatchObject({
      state: 'draft',
      lines: [
        {
          area: expect.stringContaining('Madhapur'),
          day: '2027-09-10',
          hours: [19, 20],
          bikes: 30,
          band: 'Peak',
          paisePerBikeHour: 30_000,
          paise: 1_800_000,
        },
      ],
      bikeHours: 60,
      plays: 12_000,
      listPaise: 1_800_000,
      subtotalPaise: 1_800_000,
      gst: { cgst: 162_000, sgst: 162_000, igst: 0 },
      gstPaise: 324_000,
      totalPaise: 2_124_000,
      termsVersion: TERMS_VERSION,
      agreedAt: null,
    });
    expect(r?.terms.map((t) => t.key)).toEqual([
      'promise',
      'edge',
      'make-ups',
      'late-ads',
      'report',
    ]);
    expect(r?.terms[0]?.text).toContain('200 times');
    expect(await reviewPage(pool, 'dosa-co', id, NOW)).toBeUndefined();
  });

  it('agreed and paid: a link (the same one again), the rules kept once; paid: bikes kept, invoice made', async () => {
    const id = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, weekdays: [6] }, by: who.by },
      NOW,
    );
    await expect(
      payFromPortal(
        pool,
        payments,
        { ...who, brandId: 'chai-co', bookingId: id, termsVersion: TERMS_VERSION + 1 },
        NOW,
      ),
    ).rejects.toThrow('The rules have changed');
    await expect(
      payFromPortal(pool, payments, { ...who, brandId: 'dosa-co', bookingId: id }, NOW),
    ).rejects.toThrow('No such campaign');
    const link = await payFromPortal(
      pool,
      payments,
      { ...who, brandId: 'chai-co', bookingId: id },
      NOW,
    );
    expect(link).toMatchObject({ amountPaise: 2_124_000 });
    expect(
      await payFromPortal(pool, payments, { ...who, brandId: 'chai-co', bookingId: id }, NOW + 60),
    ).toEqual(link);
    expect((await reviewPage(pool, 'chai-co', id, NOW))?.agreedAt).toBe(NOW);
    const terms = await pool.query(
      'SELECT terms_version, accepted_by FROM booking_terms WHERE booking_id = $1',
      [id],
    );
    expect(terms.rows).toEqual([{ terms_version: TERMS_VERSION, accepted_by: who.by }]);
    payments.pay(link.linkId);
    expect(
      await applyLinkStatus(pool, link.linkId, await payments.status(link.linkId), NOW + 120),
    ).toBe('paid');
    expect(
      (await portalCampaigns(pool, 'chai-co', NOW + 120)).find((c) => c.bookingId === id),
    ).toMatchObject({ stage: 'scheduled', note: 'Add your ads' });
    const inv = await pool.query(
      'SELECT kind, legal_name FROM gst_documents WHERE booking_id = $1',
      [id],
    );
    expect(inv.rows).toEqual([{ kind: 'invoice', legal_name: 'Chai Co Pvt Ltd' }]);
    await expect(
      payFromPortal(pool, payments, { ...who, brandId: 'chai-co', bookingId: id }, NOW + 200),
    ).rejects.toThrow('This campaign is paid');
  });

  it('refused before anything is kept: too soon now; a monthly deal goes to sales', async () => {
    const id = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, weekdays: [4] }, by: who.by },
      NOW,
    );
    await expect(
      payFromPortal(
        pool,
        payments,
        { ...who, brandId: 'chai-co', bookingId: id },
        NOW + 5 * 86_400,
      ),
    ).rejects.toThrow('It now starts in less than 15 days');
    expect((await reviewPage(pool, 'chai-co', id, NOW + 5 * 86_400))?.blocked).toMatch(
      /^It now starts/,
    );
    expect(
      (await pool.query('SELECT 1 FROM booking_terms WHERE booking_id = $1', [id])).rowCount,
    ).toBe(0);
    const deal = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, weekdays: [3], repeatMonths: 6 }, by: who.by },
      NOW,
    );
    expect((await reviewPage(pool, 'chai-co', deal, NOW))?.blocked).toBe(
      'A 6-month deal is set up with our sales team: they will call you',
    );
    await expect(
      payFromPortal(pool, payments, { ...who, brandId: 'chai-co', bookingId: deal }, NOW),
    ).rejects.toThrow('sales team');
    const thread = await askSalesForDeal(
      pool,
      { brandId: 'chai-co', bookingId: deal, contact: '+919848011111' },
      NOW,
    );
    expect(
      await askSalesForDeal(
        pool,
        { brandId: 'chai-co', bookingId: deal, contact: '+919848011111' },
        NOW,
      ),
    ).toBe(thread);
    const t = await pool.query<{ subject: string; party_id: string }>(
      'SELECT subject, party_id FROM support_threads WHERE thread_id = $1',
      [thread],
    );
    expect(t.rows).toEqual([{ subject: `6-month deal: booking ${deal}`, party_id: 'chai-co' }]);
    await expect(
      askSalesForDeal(pool, { brandId: 'chai-co', bookingId: id, contact: '+919848011111' }, NOW),
    ).rejects.toThrow('Only a 6- or 12-month deal');
  });

  it('prices changed since it was booked: told, not paid; a link that ran out: told', async () => {
    const id = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, weekdays: [2] }, by: who.by },
      NOW,
    );
    const link = await payFromPortal(
      pool,
      payments,
      { ...who, brandId: 'chai-co', bookingId: id },
      NOW,
    );
    expect((await reviewPage(pool, 'chai-co', id, link.expiresAt + 60))?.blocked).toBe(
      'Its payment link ran out: book again',
    );
    const old = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, weekdays: [1] }, by: who.by },
      NOW,
    );
    await savePriceBook(
      pool,
      { ...PRICE_BOOK_V1, version: 2, validFrom: '2027-08-23T05:00:00.000Z' },
      'prateek',
    );
    expect((await reviewPage(pool, 'chai-co', old, NOW + 3600))?.blocked).toBe(
      'Prices changed since you booked: book again for the new prices',
    );
    await expect(
      payFromPortal(pool, payments, { ...who, brandId: 'chai-co', bookingId: old }, NOW + 3600),
    ).rejects.toThrow('Prices changed');
  });
});
