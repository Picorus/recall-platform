// P3.9.2: review routes: Ad review and Sales look at the queue; only an Ad review admin decides; an
// approval moves a paid booking on; past its deadline it waits for a short-notice reason.
import { fakeFileStore } from '@recall/adapters';
import {
  bookingState,
  createAccount,
  createBooking,
  moveBooking,
  saveAreaVersion,
  savePriceBook,
  setBookingAds,
  uploadAd,
} from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';
import { members } from './members.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const now = Date.UTC(2027, 7, 23, 4, 30);
const NOW = Math.floor(now / 1000);
const ORIGIN = 'https://admin.test';
const files = fakeFileStore({ baseUrl: 'https://admin.test/api/files', secret: 'test' });
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
  files,
};
const member = members(() => pool, now);
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../../packages/domain/test/fixtures/ads/${name}`, import.meta.url)),
  );
const ALL = {
  'no-flashing': true,
  'not-road-sign': true,
  'allowed-category': true,
  'warnings-seen': true,
};

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
      reason: 'route test',
    },
    NOW,
  );
  server = createServer(
    apiHandler(
      pool,
      CFG,
      () => {},
      () => now,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

const post = async (cookie: string, path: string, body: object) => {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('review routes (P3.9.2)', () => {
  it('the queue, who decides, and the booking steps that follow', async () => {
    const ravi = await member('ravi@recall.in', { role: 'admin', areas: ['ad-review'] });
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const ids: string[] = [];
    for (const [name, f] of [
      ['Evening video', 'ad-15s-1280x640.mp4'],
      ['Logo card', 'ad-1280x640.png'],
    ] as const)
      ids.push(
        (await uploadAd(pool, files, { brandId: 'chai-co', name, data: fixture(f), by: 'S' }, NOW))
          .adId,
      );
    // Paid, first hour in 4 days: ads were due 3 days ago (short notice).
    await createBooking(
      pool,
      {
        bookingId: 'BK-RV-1',
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
    await moveBooking(pool, 'BK-RV-1', 'awaiting-payment', { by: 'S', actor: 'admin' }, NOW);
    await moveBooking(pool, 'BK-RV-1', 'paid', { by: 'g', actor: 'system', paymentId: 'p1' }, NOW);
    await setBookingAds(pool, 'BK-RV-1', ids, 'Sana', NOW);

    expect((await fetch(`${url}/reviews`, { headers: { cookie: fin } })).status).toBe(403);
    const q = (await (await fetch(`${url}/reviews`, { headers: { cookie: sana } })).json()) as {
      waiting: { adId: string; bookings: string[]; preview: string }[];
    };
    expect(q.waiting.map((a) => a.adId)).toEqual(ids);
    expect(q.waiting[0]?.bookings).toEqual(['BK-RV-1']);
    expect(q.waiting[0]?.preview).toContain('https://admin.test/api/files/');

    // Sales sees but does not decide; a bad request is refused in words.
    const approve = { decision: 'approved', checklist: ALL };
    expect((await post(sana, `/reviews/ad/${ids[0]}`, approve)).status).toBe(403);
    expect(await post(ravi, `/reviews/ad/${ids[0]}`, { decision: 'maybe' })).toEqual({
      status: 400,
      body: { error: 'decision must be approved or rejected' },
    });
    expect((await post(ravi, `/reviews/ad/${ids[0]}`, approve)).body).toEqual({
      approvedBookings: [],
      waiting: [],
    });
    expect((await post(ravi, `/reviews/ad/${ids[1]}`, approve)).body).toEqual({
      approvedBookings: [],
      waiting: [
        {
          bookingId: 'BK-RV-1',
          problem: 'a short-notice approval needs a reason (10 letters or more)',
        },
      ],
    });
    expect(
      await post(ravi, '/reviews/booking/BK-RV-1', { reason: 'Files came late; checked' }),
    ).toEqual({ status: 200, body: { bookingId: 'BK-RV-1', state: 'ads-approved' } });
    expect(await bookingState(pool, 'BK-RV-1')).toBe('ads-approved');
    expect((await post(ravi, `/reviews/ad/${ids[1]}`, approve)).status).toBe(400);
  });
});
