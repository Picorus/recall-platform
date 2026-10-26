// The Areas page's routes: who may look, edit shapes, add areas and turn them on or off; the area
// rules' refusals in words; never back-dated.
import { areaHistory, saveAreaVersion } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas } from '@recall/domain';
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
let now = Date.UTC(2026, 11, 1, 6);
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

const get = async (cookie: string) => {
  const r = await fetch(`${url}/areas`, { headers: { cookie } });
  return {
    status: r.status,
    body: (await r.json()) as {
      areas: {
        latest: { areaId: string; version: number; ring: { lat: number; lng: number }[] };
        history: { reason: string | null }[];
      }[];
    },
  };
};
const post = async (path: string, cookie: string, body: object) => {
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
/** A small square near (lat, lng). */
const square = (lat: number, lng: number, d = 0.002) => [
  { lat, lng },
  { lat, lng: lng + d },
  { lat: lat + d, lng: lng + d },
  { lat: lat + d, lng },
];

describe('Areas page routes (P3.5)', () => {
  it('who may look and change: Sales or Operations look; an Operations admin edits; a super admin adds and turns on or off', async () => {
    const sup = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('arjun@recall.in', { role: 'admin', areas: ['operations'] });
    const sales = await member('priya@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('meena@recall.in', { role: 'admin', areas: ['finance'] });
    expect((await get(sales)).status).toBe(200);
    expect((await get(fin)).status).toBe(403);
    const list = await get(ops);
    const madhapur = list.body.areas.find((a) => a.latest.areaId === 'hyd-madhapur');
    expect(madhapur?.latest.version).toBe(1);

    // An Operations admin moves one corner a little: version 2, with who and why.
    const ring = madhapur?.latest.ring ?? [];
    const moved = ring.map((p, i) => (i === 0 ? { lat: p.lat + 0.0005, lng: p.lng } : p));
    now += 60_000;
    const v2 = await post('/areas/hyd-madhapur/versions', ops, {
      ring: moved,
      reason: 'road widened',
    });
    expect(v2.status).toBe(200);
    const h = await areaHistory(pool, 'hyd-madhapur');
    expect(h.map((v) => v.version)).toEqual([1, 2]);
    expect(
      (await get(ops)).body.areas.find((a) => a.latest.areaId === 'hyd-madhapur')?.history[1]
        ?.reason,
    ).toBe('road widened');

    // Sales cannot edit; an Operations admin cannot add or turn off; a super admin can.
    expect(
      (await post('/areas/hyd-madhapur/versions', sales, { edgeMeters: 200, reason: 'try' }))
        .status,
    ).toBe(403);
    expect(
      (await post('/areas/hyd-madhapur/versions', ops, { active: false, reason: 'try' })).status,
    ).toBe(403);
    expect(
      (await post('/areas/hyd-madhapur/active', ops, { active: false, reason: 'try' })).status,
    ).toBe(403);
    const add = {
      areaId: 'hyd-test-far',
      name: 'Far test',
      city: 'Hyderabad',
      ring: square(17.3, 78.6),
      edgeMeters: 300,
      reason: 'pilot',
    };
    expect((await post('/areas', ops, add)).status).toBe(403);
    now += 60_000;
    expect((await post('/areas', sup, add)).status).toBe(200);
    now += 60_000;
    expect(
      (await post('/areas/hyd-test-far/active', sup, { active: false, reason: 'pilot over' }))
        .status,
    ).toBe(200);
    expect((await areaHistory(pool, 'hyd-test-far')).map((v) => v.active)).toEqual([true, false]);
  });

  it('the rules refuse in words: an overlap names the other area; a crossing border; never back-dated', async () => {
    const ops = await member('kiran@recall.in', { role: 'admin', areas: ['operations'] });
    const sup = await member('second@recall.in', { role: 'super-admin', areas: [] });
    const list = await get(ops);
    const kondapur =
      list.body.areas.find((a) => a.latest.areaId === 'hyd-kondapur')?.latest.ring ?? [];
    // A new area right on top of Kondapur.
    now += 60_000;
    const over = await post('/areas', sup, {
      areaId: 'hyd-overlap',
      name: 'Overlap',
      city: 'Hyderabad',
      ring: kondapur,
      edgeMeters: 300,
      reason: 'test',
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/^overlaps or touches Kondapur/);
    // The check alone: nothing saved.
    const check = await post('/areas/check', ops, { ring: kondapur, edgeMeters: 300 });
    expect((check.body.problems as string[])[0]).toMatch(/Kondapur/);
    const bow = [
      { lat: 17.3, lng: 78.7 },
      { lat: 17.31, lng: 78.71 },
      { lat: 17.3, lng: 78.71 },
      { lat: 17.31, lng: 78.7 },
    ];
    expect((await post('/areas/check', ops, { ring: bow, edgeMeters: 300 })).body.problems).toEqual(
      ['needs 3+ corners and its border must not cross itself'],
    );
    const past = new Date(now - 3_600_000).toISOString();
    const back = await post('/areas/hyd-madhapur/versions', ops, {
      edgeMeters: 250,
      validFrom: past,
      reason: 'tidy',
    });
    expect(back).toEqual({ status: 400, body: { error: 'A change cannot start in the past' } });
    expect(
      (await post('/areas/hyd-madhapur/versions', ops, { edgeMeters: 5000, reason: 'wide' }))
        .status,
    ).toBe(400);
    expect(
      (await post('/areas/hyd-nowhere/versions', ops, { edgeMeters: 200, reason: 'x y' })).status,
    ).toBe(404);
  });
});
