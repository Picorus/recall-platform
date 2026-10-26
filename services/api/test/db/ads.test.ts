// P3.9.1: ad routes: who may upload and look; a file checked from its bytes; a booking's ads;
// the laptop store's files only through genuine, unexpired links.
import { fakeFileStore } from '@recall/adapters';
import { createAccount, createBooking, saveAreaVersion, savePriceBook } from '@recall/db';
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
  readFileSync(new URL(`../../../../packages/domain/test/fixtures/ads/${name}`, import.meta.url));

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
    Math.floor(now / 1000),
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

const upload = async (cookie: string, name: string, data: Buffer) => {
  const r = await fetch(`${url}/ads/upload?brand=chai-co&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/octet-stream' },
    body: data,
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('ad routes (P3.9.1)', () => {
  it('a Sales admin uploads; Sales, Ad review and Support look; the file is read from its bytes', async () => {
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const rev = await member('ravi@recall.in', { role: 'read-only', areas: ['ad-review'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    expect((await upload(rev, 'x', fixture('ad-1280x720.png'))).status).toBe(403);
    const up = await upload(sana, 'Evening offer', fixture('ad-15s-1280x720.mp4'));
    expect(up).toMatchObject({
      status: 200,
      body: { ad: { kind: 'mp4', durationMs: 15_000, outcome: 'pass' } },
    });
    expect((await upload(sana, 'Second', fixture('ad-1280x720.jpg'))).status).toBe(200);
    expect((await upload(sana, 'Not an ad', Buffer.from('%PDF-1.7 hello there'))).body.error).toBe(
      'Not a picture (PNG, JPEG, WebP) or an MP4 video',
    );
    expect((await upload(sana, '', fixture('ad-1280x720.png'))).body.error).toBe(
      'Give the ad a name (1 to 80 characters)',
    );
    expect((await fetch(`${url}/ads?brand=chai-co`, { headers: { cookie: fin } })).status).toBe(
      403,
    );
    const list = (await (
      await fetch(`${url}/ads?brand=chai-co`, { headers: { cookie: rev } })
    ).json()) as {
      ads: { adId: string; name: string; preview: string }[];
    };
    expect(list.ads.map((a) => a.name)).toEqual(['Second', 'Evening offer']);

    // The preview link opens the file (the admin site passes /api/files/... to the API).
    const link = new URL(list.ads[1]?.preview ?? '');
    const file = await fetch(`${url}${link.pathname.replace('/api', '')}${link.search}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await file.arrayBuffer()).equals(fixture('ad-15s-1280x720.mp4'))).toBe(true);
    const forged = `${url}${link.pathname.replace('/api', '')}?until=${Math.floor(now / 1000) + 99_999}&sig=${'0'.repeat(64)}`;
    expect((await fetch(forged)).status).toBe(403);

    // A booking's ads.
    await createBooking(
      pool,
      {
        bookingId: 'BK-ADS-1',
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
      Math.floor(now / 1000),
    );
    const set = async (adIds: string[]) => {
      const r = await fetch(`${url}/ads/booking/BK-ADS-1`, {
        method: 'POST',
        headers: { cookie: sana, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ adIds }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect((await set([list.ads[0]?.adId ?? ''])).body.error).toBe(
      'Choose 2 to 5 ads (they take turns)',
    );
    expect(await set(list.ads.map((a) => a.adId))).toEqual({ status: 200, body: { version: 1 } });
    const chosen = (await (
      await fetch(`${url}/ads/booking/BK-ADS-1`, { headers: { cookie: rev } })
    ).json()) as {
      ads: { name: string }[];
    };
    expect(chosen.ads.map((a) => a.name)).toEqual(['Second', 'Evening offer']);
  });
});
