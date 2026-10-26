// P3.10: delivery routes: who looks, a day's lines and a booking's; only a super admin decides a
// refund, with why.
import { createBooking, moveBooking, saveAreaVersion, savePriceBook } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, lineStartsAt, PRICE_BOOK_V1 } from '@recall/domain';
import { randomBytes } from 'node:crypto';
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
const DATE = '2027-08-24';
const now = (lineStartsAt({ date: DATE, startHour: 18 }) + 1800) * 1000; // 18:30 India time
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
};
const member = members(() => pool, now);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createBooking(
    pool,
    {
      bookingId: 'BK-DL-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: DATE, startHour: 18, bikes: 30 },
          { areaId: 'hyd-madhapur', date: DATE, startHour: 19, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, 'BK-DL-1', 'awaiting-payment', { by: 'p', actor: 'admin' }, BOOKED);
  await moveBooking(pool, 'BK-DL-1', 'paid', { by: 'g', actor: 'system' }, BOOKED + 60);
  await moveBooking(pool, 'BK-DL-1', 'ads-approved', { by: 'r', actor: 'admin' }, BOOKED + 120);
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

describe('delivery routes (P3.10)', () => {
  it('who looks; today by default; a booking; refunds only by a super admin', async () => {
    const ops = await member('omar@recall.in', { role: 'read-only', areas: ['operations'] });
    const rev = await member('ravi@recall.in', { role: 'admin', areas: ['ad-review'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });

    expect((await get(rev, '/delivery')).status).toBe(403);
    const day = (await (await get(ops, '/delivery')).json()) as {
      day: string;
      lines: { startHour: number; view: { status: string } }[];
    };
    expect(day.day).toBe(DATE);
    expect(day.lines.map((l) => [l.startHour, l.view.status])).toEqual([
      [18, 'live'],
      [19, 'upcoming'],
    ]);
    expect((await get(ops, '/delivery?day=24-08-2027')).status).toBe(400);
    expect((await get(ops, '/delivery?day=2027-02-30')).status).toBe(400);
    expect(await (await get(fin, '/delivery/refunds')).json()).toMatchObject({
      lines: [],
      truncated: false,
    });
    const one = (await (await get(fin, '/delivery/booking/BK-DL-1')).json()) as {
      lines: { bookingId: string; promised: number }[];
    };
    expect(one.lines).toHaveLength(2);
    expect(one.lines[0]).toMatchObject({ bookingId: 'BK-DL-1', promised: 6_000 });

    const decide = (cookie: string, body: object) =>
      fetch(`${url}/delivery/refund`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ refundId: 'BK-DL-1/hyd-madhapur/2027-08-24/18#refund', ...body }),
      });
    expect((await decide(fin, { decision: 'approved', reason: 'short by 10' })).status).toBe(403);
    const boss = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    expect((await decide(boss, { decision: 'approved', reason: 'ok' })).status).toBe(400);
    const missing = await decide(boss, { decision: 'approved', reason: 'short by 10 plays' });
    expect([missing.status, ((await missing.json()) as { error: string }).error]).toEqual([
      404,
      'No refund BK-DL-1/hyd-madhapur/2027-08-24/18#refund',
    ]);
  });
});
