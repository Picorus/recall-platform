// P3.9.1: ads uploaded for a brand, checked from their bytes and stored once by fingerprint; which
// of them a booking runs (2 to 5, its brand's own, none that failed).
import { fakeFileStore } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { adById, bookingAds, brandAds, setBookingAds, uploadAd } from '../../src/ads.js';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
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
const brand = (brandId: string) =>
  createAccount(
    pool,
    {
      brandId,
      kind: 'brand',
      details: { name: brandId, agencyId: null, referredBy: null, active: true },
      by: 'test',
      reason: 'ads test',
    },
    NOW,
  );

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await brand('chai-co');
  await brand('dosa-co');
});
afterAll(async () => db.drop());

describe('ads (P3.9.1)', () => {
  it('an upload is read from its bytes, checked by the rules in force, stored once', async () => {
    const v = await uploadAd(
      pool,
      store,
      { brandId: 'chai-co', name: 'Evening offer', data: file('ad-15s-1280x720.mp4'), by: 'Sana' },
      NOW,
    );
    expect(v).toMatchObject({
      adId: expect.stringMatching(/^AD-[0-9A-F]{10}$/),
      kind: 'mp4',
      width: 1280,
      height: 720,
      durationMs: 15_000,
      codec: 'avc1',
      outcome: 'pass',
    });
    expect(await store.get(v.fileKey)).toMatchObject({ contentType: 'video/mp4' });
    // The same file again: a second ad, the same stored file.
    const again = await uploadAd(
      pool,
      store,
      {
        brandId: 'chai-co',
        name: 'Evening offer (copy)',
        data: file('ad-15s-1280x720.mp4'),
        by: 'Sana',
      },
      NOW + 1,
    );
    expect(again.fileKey).toBe(v.fileKey);
    expect(store.files.size).toBe(1);
    // A 3-second video fails (kept, so staff see why); not a picture or video at all is refused.
    const short = await uploadAd(
      pool,
      store,
      { brandId: 'chai-co', name: 'Too short', data: file('ad-3s-1280x640.mp4'), by: 'Sana' },
      NOW + 2,
    );
    expect(short.outcome).toBe('fail');
    await expect(
      uploadAd(
        pool,
        store,
        {
          brandId: 'chai-co',
          name: 'PDF',
          data: new TextEncoder().encode('%PDF-1.7 xxxxxxxx'),
          by: 'S',
        },
        NOW,
      ),
    ).rejects.toThrow('Not a picture');
    await expect(
      uploadAd(
        pool,
        store,
        { brandId: 'nobody', name: 'x', data: file('ad-1280x720.png'), by: 'S' },
        NOW,
      ),
    ).rejects.toThrow('No brand nobody');
    expect((await brandAds(pool, 'chai-co')).map((a) => a.name)).toEqual([
      'Too short',
      'Evening offer (copy)',
      'Evening offer',
    ]);
    expect(await adById(pool, v.adId)).toEqual(v);
  });

  it('a booking runs 2 to 5 of its brand’s ads, none that failed; changes are versions', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-AD-1',
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
    const ads = await brandAds(pool, 'chai-co');
    const ok = ads.filter((a) => a.outcome !== 'fail').map((a) => a.adId);
    const failed = ads.find((a) => a.outcome === 'fail')?.adId ?? '';
    const pic = await uploadAd(
      pool,
      store,
      { brandId: 'chai-co', name: 'Logo card', data: file('ad-1280x720.png'), by: 'Sana' },
      NOW + 3,
    );
    const theirs = await uploadAd(
      pool,
      store,
      { brandId: 'dosa-co', name: 'Dosa', data: file('ad-1280x720.jpg'), by: 'Sana' },
      NOW + 3,
    );
    await expect(setBookingAds(pool, 'BK-AD-1', [ok[0] ?? ''], 'Sana', NOW)).rejects.toThrow(
      'Choose 2 to 5',
    );
    await expect(setBookingAds(pool, 'BK-AD-1', [...ok, failed], 'Sana', NOW)).rejects.toThrow(
      'failed the automatic checks',
    );
    await expect(setBookingAds(pool, 'BK-AD-1', [...ok, theirs.adId], 'Sana', NOW)).rejects.toThrow(
      "not one of this brand's ads",
    );
    expect(await setBookingAds(pool, 'BK-AD-1', ok, 'Sana', NOW + 10)).toBe(1);
    expect(await setBookingAds(pool, 'BK-AD-1', [pic.adId, ...ok], 'Sana', NOW + 20)).toBe(2);
    expect((await bookingAds(pool, 'BK-AD-1')).map((a) => a.adId)).toEqual([pic.adId, ...ok]);
    // Not once it has started.
    const start = Date.UTC(2027, 7, 27, 13, 30) / 1000;
    await expect(setBookingAds(pool, 'BK-AD-1', ok, 'Sana', start)).rejects.toThrow(
      'before the booking runs',
    );
    await expect(pool.query("UPDATE ads SET name = 'x'")).rejects.toThrow();
  });
});
