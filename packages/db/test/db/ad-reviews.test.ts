// P3.9.2: a person's decision on each ad (final, never edited) and the booking steps it unlocks:
// a paid booking runs once all its ads are approved; past its deadline only with a reviewer's reason.
import { fakeFileStore } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveOnShortNotice, reviewAd, reviewQueue } from '../../src/ad-reviews.js';
import { adById, advanceIfReady, setBookingAds, uploadAd } from '../../src/ads.js';
import { saveAreaVersion } from '../../src/areas.js';
import { bookingState, createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { createAccount } from '../../src/brands.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const store = fakeFileStore({ baseUrl: 'http://localhost:8080/files', secret: 'test' });
const file = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../domain/test/fixtures/ads/${name}`, import.meta.url)),
  );
const ALL = {
  'no-flashing': true,
  'not-road-sign': true,
  'allowed-category': true,
  'warnings-seen': true,
};
const upload = async (name: string, f: string) =>
  (await uploadAd(pool, store, { brandId: 'chai-co', name, data: file(f), by: 'Sana' }, NOW)).adId;
/** A paid booking for one evening hour on `date`. */
const paidBooking = async (bookingId: string, date: string) => {
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
    NOW,
  );
  await moveBooking(pool, bookingId, 'awaiting-payment', { by: 'Sana', actor: 'admin' }, NOW);
  await moveBooking(
    pool,
    bookingId,
    'paid',
    { by: 'gateway', actor: 'system', paymentId: `pay_${bookingId}` },
    NOW,
  );
};
const approve = (adId: string, reason: string | null = null) =>
  reviewAd(pool, { adId, decision: 'approved', reason, checklist: ALL, by: 'Ravi' }, NOW + 60);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createAccount(
    pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'test',
      reason: 'reviews test',
    },
    NOW,
  );
}, 120_000);
afterAll(async () => db.drop());

describe('ad review (P3.9.2)', () => {
  it('approve with every rule ticked, reject with why; once; a booking runs when all are approved', async () => {
    const video = await upload('Evening video', 'ad-15s-1280x640.mp4');
    const card = await upload('Logo card', 'ad-1280x640.png');
    const short = await upload('Too short', 'ad-3s-1280x640.mp4');
    await paidBooking('BK-R-1', '2027-09-10');
    await setBookingAds(pool, 'BK-R-1', [video, card], 'Sana', NOW);

    const refused = async (r: Parameters<typeof reviewAd>[1], msg: string) =>
      expect(reviewAd(pool, r, NOW)).rejects.toThrow(msg);
    await refused(
      { adId: video, decision: 'approved', reason: null, checklist: {}, by: 'Ravi' },
      'Tick every rule to approve',
    );
    await refused(
      { adId: video, decision: 'rejected', reason: 'bad', checklist: {}, by: 'Ravi' },
      'Say why in 10 to 500 letters',
    );
    await refused(
      { adId: short, decision: 'approved', reason: null, checklist: ALL, by: 'Ravi' },
      'it can only be rejected',
    );

    // One approved: the booking still waits for the other.
    expect(await approve(video)).toEqual({ approvedBookings: [], waiting: [] });
    expect(await bookingState(pool, 'BK-R-1')).toBe('paid');
    expect(await approve(card)).toEqual({ approvedBookings: ['BK-R-1'], waiting: [] });
    expect(await bookingState(pool, 'BK-R-1')).toBe('ads-approved');
    // A decision is final.
    await expect(approve(card)).rejects.toThrow('already approved by Ravi');
    expect((await adById(pool, card))?.review).toMatchObject({ decision: 'approved', by: 'Ravi' });

    // A rejected ad cannot be chosen; once approved, a booking takes only approved ads.
    const sign = await upload('Stop sign', 'ad-1280x640.webp');
    await reviewAd(
      pool,
      {
        adId: sign,
        decision: 'rejected',
        reason: 'Looks like a traffic sign',
        checklist: {},
        by: 'Ravi',
      },
      NOW,
    );
    await expect(setBookingAds(pool, 'BK-R-1', [video, sign], 'Sana', NOW)).rejects.toThrow(
      'was rejected in review',
    );
    const fresh = await upload('New card', 'ad-1280x640.jpg');
    await expect(setBookingAds(pool, 'BK-R-1', [video, fresh], 'Sana', NOW)).rejects.toThrow(
      'choose only approved ads',
    );
    expect(await setBookingAds(pool, 'BK-R-1', [card, video], 'Sana', NOW)).toBe(2);
    expect(await bookingState(pool, 'BK-R-1')).toBe('ads-approved');
    await expect(pool.query("UPDATE ad_reviews SET reason = 'x'")).rejects.toThrow();
  });

  it('past the deadline a booking waits for a reviewer’s reason; the queue shows what is most urgent', async () => {
    const [a, b] = [
      await upload('Late one', 'ad-15s-1280x640.mp4'),
      await upload('Late two', 'ad-1280x640.png'),
    ];
    // First hour in 4 days: ads were due 3 days ago.
    await paidBooking('BK-R-2', '2027-08-27');
    await setBookingAds(pool, 'BK-R-2', [a, b], 'Sana', NOW);
    const q = await reviewQueue(pool);
    expect(q.waiting.slice(0, 2).map((x) => x.adId)).toEqual([a, b]);
    expect(q.waiting[0]).toMatchObject({ brandName: 'Chai Co', bookings: ['BK-R-2'] });
    expect(q.waiting[0]?.neededBy).toBe(Date.UTC(2027, 7, 20, 13, 30) / 1000);

    await approve(a);
    const out = await approve(b);
    expect(out.approvedBookings).toEqual([]);
    expect(out.waiting).toEqual([
      {
        bookingId: 'BK-R-2',
        problem: 'a short-notice approval needs a reason (10 letters or more)',
      },
    ]);
    expect((await reviewQueue(pool)).shortNotice.map((x) => x.bookingId)).toEqual(['BK-R-2']);
    await expect(approveOnShortNotice(pool, 'BK-R-2', 'Ravi', 'ok', NOW)).rejects.toThrow(
      'Say why',
    );
    await approveOnShortNotice(
      pool,
      'BK-R-2',
      'Ravi',
      'Brand sent files late; checked by eye',
      NOW,
    );
    expect(await bookingState(pool, 'BK-R-2')).toBe('ads-approved');
    const step = await pool.query(
      "SELECT reason, by_who FROM booking_events WHERE booking_id = 'BK-R-2' AND state = 'ads-approved'",
    );
    expect(step.rows[0]?.reason).toBe('Brand sent files late; checked by eye');
    expect((await reviewQueue(pool)).shortNotice).toEqual([]);
  });

  it('a booking paid after its ads were approved moves on by itself (before its deadline)', async () => {
    const [a, b] = [
      await upload('Ready one', 'ad-15s-1280x640.mp4'),
      await upload('Ready two', 'ad-1280x640.png'),
    ];
    await approve(a);
    await approve(b);
    await createBooking(
      pool,
      {
        bookingId: 'BK-R-3',
        brandId: 'chai-co',
        request: {
          lines: [
            { areaId: 'hyd-madhapur', date: '2027-09-12', startHour: 19, bikes: 30 },
            { areaId: 'hyd-madhapur', date: '2027-09-12', startHour: 20, bikes: 30 },
          ],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'Sana',
      },
      NOW,
    );
    await setBookingAds(pool, 'BK-R-3', [a, b], 'Sana', NOW);
    expect(await advanceIfReady(pool, 'BK-R-3', { by: 'x', actor: 'system' }, NOW)).toBe(
      'the booking is draft',
    );
    await moveBooking(pool, 'BK-R-3', 'awaiting-payment', { by: 'Sana', actor: 'admin' }, NOW);
    await moveBooking(
      pool,
      'BK-R-3',
      'paid',
      { by: 'gateway', actor: 'system', paymentId: 'pay_r3' },
      NOW,
    );
    expect(await advanceIfReady(pool, 'BK-R-3', { by: 'payments', actor: 'system' }, NOW)).toBe(
      undefined,
    );
    expect(await bookingState(pool, 'BK-R-3')).toBe('ads-approved');
  });
});
