// The inventory calendar's routes: who may look, hold, release, book from a hold and set limits;
// refusals in words; a full area-hour as 409.
import { savePriceBook, saveAreaVersion } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
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
// Mon 23 Aug 2027, 10:00 India time.
const now = Date.UTC(2027, 7, 23, 4, 30);
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

interface Cell {
  date: string;
  startHour: number;
  booked: number;
  held: number;
  limit: number | null;
  free: number | null;
}
interface Week {
  areas: { areaId: string; name: string }[];
  week: {
    areaId: string;
    days: string[];
    cells: Cell[];
    holds: { holdId: string; brandId: string; bookingId: string | null; endedEarly: unknown }[];
  };
}
const get = async (cookie: string, q = '') => {
  const r = await fetch(`${url}/calendar${q}`, { headers: { cookie } });
  return { status: r.status, body: (await r.json()) as Week };
};
const post = async (path: string, cookie: string, body: object) => {
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const cellAt = (w: Week, date: string, hour: number) =>
  w.week.cells.find((c) => c.date === date && c.startHour === hour);
const until = Math.floor(now / 1000) + 2 * 86_400;

describe('inventory calendar routes (P3.7)', () => {
  it('Sales and Operations look (read-only too); the default is the first area from today', async () => {
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const ops = await member('olu@recall.in', { role: 'read-only', areas: ['operations'] });
    expect((await get(fin)).status).toBe(403);
    const w = await get(ops);
    expect(w.status).toBe(200);
    expect(w.body.areas.length).toBeGreaterThan(1);
    expect(w.body.week.areaId).toBe(w.body.areas[0]?.areaId);
    expect(w.body.week.days[0]).toBe('2027-08-23');
    expect(w.body.week.cells).toHaveLength(126);
    const other = await get(ops, '?area=hyd-madhapur&from=2027-08-27');
    expect(other.body.week).toMatchObject({
      areaId: 'hyd-madhapur',
      days: expect.arrayContaining(['2027-09-02']),
    });
    expect((await get(ops, '?area=hyd-madhapur&from=2027-02-30')).status).toBe(400);
  });

  it('a super admin sets a limit; a Sales admin holds within it; over it is 409 with what is free', async () => {
    const sup = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const ro = await member('rita@recall.in', { role: 'read-only', areas: ['sales'] });
    const limit = {
      areaId: 'hyd-madhapur',
      date: '2027-08-27',
      startHour: 19,
      maxBikes: 40,
      reason: 'flyover works',
    };
    expect((await post('/calendar/limit', sana, limit)).status).toBe(403);
    expect((await post('/calendar/limit', sup, { ...limit, maxBikes: -1 })).status).toBe(400);
    for (const startHour of [3, 8.5, 26])
      expect((await post('/calendar/limit', sup, { ...limit, startHour })).body.error).toBe(
        'startHour must be a start hour (8 to 25)',
      );
    expect(
      (await post('/calendar/limit', sup, { ...limit, areaId: 'hyd-nowhere' })).body.error,
    ).toBe('No such area');
    expect((await post('/calendar/limit', sup, limit)).status).toBe(200);
    const hold = {
      brandId: 'chai-co',
      areaId: 'hyd-madhapur',
      dates: ['2027-08-27'],
      hours: [19, 20, 21],
      bikes: 25,
      until,
      reason: 'call on Monday',
    };
    expect((await post('/holds', ro, hold)).status).toBe(403);
    const placed = await post('/holds', sana, hold);
    expect(placed.status).toBe(200);
    expect(placed.body.holdId).toMatch(/^HLD-[0-9A-F]{10}$/);
    const w = (await get(sana, '?area=hyd-madhapur&from=2027-08-23')).body;
    expect(cellAt(w, '2027-08-27', 19)).toMatchObject({ held: 25, limit: 40, free: 15 });
    expect(cellAt(w, '2027-08-27', 20)).toMatchObject({ held: 25, limit: null, free: null });
    const over = await post('/holds', sana, {
      ...hold,
      brandId: 'dosa-co',
      hours: [19],
      bikes: 16,
    });
    expect(over).toMatchObject({
      status: 409,
      body: { error: 'Not enough bikes left: 2027-08-27 19:00 has 15 free' },
    });
    // Refused with why.
    expect((await post('/holds', sana, { ...hold, bikes: 0 })).body.error).toBe(
      'Bikes must be a whole number, 1 or more',
    );
    expect((await post('/holds', sana, { ...hold, until: until + 40 * 86_400 })).body.error).toBe(
      'A hold lasts at most 30 days',
    );
    expect((await post('/holds', sana, { ...hold, areaId: 'nowhere' })).body.error).toBe(
      'That area is not on sale',
    );
    // Hours already started cannot be held (10:00 today has started at 10:00).
    expect(
      (await post('/holds', sana, { ...hold, dates: ['2027-08-23'], hours: [8, 19] })).body.error,
    ).toBe('2027-08-23 08:00 has already started');
    expect((await post('/holds', sana, { ...hold, reason: 'x' })).body.error).toBe(
      'Give a reason (3 to 200 characters)',
    );
  });

  it('a hold turned into a draft booking (priced, for its brand); released early with why; then refused', async () => {
    const sana = await member('sana2@recall.in', { role: 'admin', areas: ['sales'] });
    const w0 = (await get(sana, '?area=hyd-madhapur&from=2027-08-23')).body;
    const holdId = w0.week.holds[0]?.holdId ?? '';
    const booked = await post(`/holds/${holdId}/book`, sana, {});
    expect(booked.status).toBe(200);
    // 25 bikes × 3 Peak hours × ₹300 = ₹22,500 + 18% GST.
    expect(booked.body).toMatchObject({
      bookingId: expect.stringMatching(/^BK-/),
      subtotal: 2_250_000,
      gst: 405_000,
    });
    const r = await pool.query<{ brand_id: string; hold_id: string }>(
      'SELECT brand_id, hold_id FROM bookings WHERE booking_id = $1',
      [booked.body.bookingId],
    );
    expect(r.rows[0]).toEqual({ brand_id: 'chai-co', hold_id: holdId });
    // A draft keeps nothing on its own: the hold still keeps the bikes until it is released.
    expect(
      cellAt((await get(sana, '?area=hyd-madhapur&from=2027-08-23')).body, '2027-08-27', 19),
    ).toMatchObject({
      held: 25,
    });
    expect(
      (await post(`/holds/${holdId}/end`, sana, { reason: 'client chose another week' })).status,
    ).toBe(200);
    const w = (await get(sana, '?area=hyd-madhapur&from=2027-08-23')).body;
    expect(cellAt(w, '2027-08-27', 19)).toMatchObject({ held: 0, free: 40 });
    expect(w.week.holds[0]?.endedEarly).toMatchObject({ reason: 'client chose another week' });
    expect((await post(`/holds/${holdId}/end`, sana, { reason: 'again' })).body.error).toBe(
      'This hold was already released',
    );
    const again = await post(`/holds/${holdId}/book`, sana, {});
    expect(again).toMatchObject({
      status: 409,
      body: { error: `Booking ${String(booked.body.bookingId)} was already made from this hold` },
    });
    expect((await post('/holds/HLD-NOPE/book', sana, {})).status).toBe(404);
  });

  it('a hold whose hours cannot be sold says why when booked (below the minimum spend)', async () => {
    const sana = await member('sana3@recall.in', { role: 'admin', areas: ['sales'] });
    const small = await post('/holds', sana, {
      brandId: 'tea-co',
      areaId: 'hyd-madhapur',
      dates: ['2027-08-28'],
      hours: [12],
      bikes: 5,
      until,
      reason: 'small test',
    });
    const res = await post(`/holds/${String(small.body.holdId)}/book`, sana, {});
    expect(res).toMatchObject({
      status: 400,
      body: { error: 'the minimum booking is ₹15,000 before GST' },
    });
  });
});
