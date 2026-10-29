// The Areas page's routes: who may look, edit shapes, add areas and turn them on or off; the area
// rules' refusals in words; never back-dated.
import { areaHistory, saveAreaVersion } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, publishedAt } from '@recall/domain';
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
    expect(over.body.error).toMatch(
      /^overlaps Kondapur by about [\d,]+ m²: neighbours may share a border, but never overlap$/,
    );
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
    // Changes start now: never back-dated, never scheduled ahead.
    const past = new Date(now - 3_600_000).toISOString();
    const back = await post('/areas/hyd-madhapur/versions', ops, {
      edgeMeters: 250,
      validFrom: past,
      reason: 'tidy',
    });
    expect(back).toEqual({
      status: 400,
      body: { error: 'Changes start now: they are not scheduled ahead' },
    });
    expect(
      (await post('/areas/hyd-madhapur/versions', ops, { edgeMeters: 5000, reason: 'wide' }))
        .status,
    ).toBe(400);
    expect(
      (await post('/areas/hyd-nowhere/versions', ops, { edgeMeters: 200, reason: 'x y' })).status,
    ).toBe(404);
  });

  it('turning off with a draft pending takes effect at once (it builds on the published shape)', async () => {
    const sup = await member('third@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('lata@recall.in', { role: 'admin', areas: ['operations'] });
    now += 60_000;
    expect(
      (
        await post('/areas/hyd-gachibowli/versions', ops, {
          edgeMeters: 150,
          draft: true,
          reason: 'proposal',
        })
      ).status,
    ).toBe(200);
    now += 60_000;
    expect(
      (await post('/areas/hyd-gachibowli/active', sup, { active: false, reason: 'flooding' }))
        .status,
    ).toBe(200);
    const h = await areaHistory(pool, 'hyd-gachibowli');
    const last = h[h.length - 1];
    expect(last).toMatchObject({ active: false, draft: false, edgeMeters: 300 });
    expect(publishedAt(h, new Date(now + 1000).toISOString())?.active).toBe(false);
  });

  it('a new area published for the first time needs a super admin', async () => {
    const sup = await member('fourth@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('ravi@recall.in', { role: 'admin', areas: ['operations'] });
    now += 60_000;
    const add = {
      areaId: 'hyd-test-draft',
      name: 'Draft test',
      city: 'Hyderabad',
      ring: square(17.2, 78.6),
      edgeMeters: 300,
      draft: true,
      reason: 'proposal',
    };
    expect((await post('/areas', sup, add)).status).toBe(200);
    now += 60_000;
    const pub = await post('/areas/hyd-test-draft/versions', ops, {
      draft: false,
      reason: 'ready',
    });
    expect(pub).toEqual({
      status: 403,
      body: { error: 'Only a super admin publishes a new area for the first time' },
    });
    // Shape fixes as a draft are fine for Operations.
    expect(
      (await post('/areas/hyd-test-draft/versions', ops, { edgeMeters: 200, reason: 'fix' }))
        .status,
    ).toBe(200);
  });

  it('P1.1.7: Check shows the gap, the shared border and any overlap; a neighbour that only touches is saved', async () => {
    const ops = await member('ravi.ops@recall.in', { role: 'admin', areas: ['operations'] });
    const sup = await member('sixth@recall.in', { role: 'super-admin', areas: [] });
    // Hitech City (east border 78.385) and Madhapur (west border 78.387) leave a 212 m gap.
    const list = await get(ops);
    const ring = (id: string) =>
      list.body.areas.find((a) => a.latest.areaId === id)?.latest.ring ?? [];
    type N = {
      areaId: string;
      name: string;
      gapMeters: number;
      gap: { from: { lng: number }; to: { lng: number } } | null;
      sharedMeters: number;
      overlapSqm: number;
      overlap: unknown[];
    };
    const check = async (r: { lat: number; lng: number }[]) => {
      const x = await post('/areas/check', ops, {
        areaId: 'hyd-hitech-city',
        ring: r,
        edgeMeters: 300,
      });
      return { problems: x.body.problems as string[], neighbours: x.body.neighbours as N[] };
    };
    const before = await check(ring('hyd-hitech-city'));
    expect(before.problems).toEqual([]);
    const m = before.neighbours.find((n) => n.areaId === 'hyd-madhapur');
    expect(m?.gapMeters).toBeGreaterThan(205);
    expect(m?.gapMeters).toBeLessThan(220);
    expect(m?.gap?.from.lng).toBeCloseTo(78.385, 6);
    expect(m?.gap?.to.lng).toBeCloseTo(78.387, 6);
    // Its east border moved onto Madhapur's west border: they share 1.8 km (17.4385, Madhapur's corner
    // moved by the first test, to 17.455).
    const touching = ring('hyd-hitech-city').map((p) =>
      p.lng > 78.38 ? { ...p, lng: 78.387 } : p,
    );
    const after = await check(touching);
    expect(after.problems).toEqual([]);
    const t = after.neighbours.find((n) => n.areaId === 'hyd-madhapur');
    expect(t).toMatchObject({ gapMeters: 0, gap: null, overlap: [] });
    expect(t?.sharedMeters).toBeGreaterThan(1_830);
    expect(t?.sharedMeters).toBeLessThan(1_840);
    // 20 m further east: an overlap, shown where it is.
    const over = await check(touching.map((p) => (p.lng > 78.38 ? { ...p, lng: 78.3872 } : p)));
    expect(over.problems).toEqual([expect.stringMatching(/^overlaps Madhapur by about [\d,]+ m²/)]);
    const o = over.neighbours.find((n) => n.areaId === 'hyd-madhapur');
    expect(o?.overlapSqm).toBeGreaterThan(30_000);
    expect(o?.overlap.length).toBeGreaterThan(0);
    // The touching shape saves (Operations corrects shapes).
    now += 60_000;
    const saved = await post('/areas/hyd-hitech-city/versions', ops, {
      ring: touching,
      reason: 'no gap with Madhapur',
    });
    expect(saved.status).toBe(200);
    // A new area that only touches Madhapur at a corner saves too (a super admin adds areas).
    now += 60_000;
    const corner = {
      areaId: 'hyd-test-corner',
      name: 'Corner test',
      city: 'Hyderabad',
      ring: square(17.458, 78.402),
      edgeMeters: 300,
      reason: 'touches Madhapur at its north-east corner',
    };
    expect((await post('/areas', sup, corner)).status).toBe(200);
  });

  it('an old shape no longer in force never blocks a new area', async () => {
    const sup = await member('fifth@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('sita@recall.in', { role: 'admin', areas: ['operations'] });
    now += 60_000;
    const big = {
      areaId: 'hyd-test-big',
      name: 'Big test',
      city: 'Hyderabad',
      ring: square(17.1, 78.5, 0.02),
      edgeMeters: 300,
      reason: 'pilot',
    };
    expect((await post('/areas', sup, big)).status).toBe(200);
    now += 60_000;
    expect(
      (
        await post('/areas/hyd-test-big/versions', ops, {
          ring: square(17.1, 78.5, 0.005),
          reason: 'smaller',
        })
      ).status,
    ).toBe(200);
    now += 60_000;
    // Where the old, bigger shape was: allowed now.
    const next = {
      areaId: 'hyd-test-next',
      name: 'Next test',
      city: 'Hyderabad',
      ring: square(17.11, 78.51, 0.005),
      edgeMeters: 300,
      reason: 'pilot 2',
    };
    expect(
      (await post('/areas/check', ops, { ring: next.ring, edgeMeters: 300 })).body.problems,
    ).toEqual([]);
    expect((await post('/areas', sup, next)).status).toBe(200);
  });

  it('a version already set for later: a change now is refused with why; two edits at once: one wins, one is told to reload', async () => {
    const ops = await member('uma@recall.in', { role: 'admin', areas: ['operations'] });
    const h = await areaHistory(pool, 'hyd-banjara-hills');
    const last = h[h.length - 1];
    if (!last) throw new Error('no area');
    // Set up by a script for next month (the page itself never schedules).
    await saveAreaVersion(
      pool,
      {
        ...last,
        version: last.version + 1,
        edgeMeters: 280,
        validFrom: new Date(now + 30 * 86_400_000).toISOString(),
      },
      'system',
    );
    now += 60_000;
    const r = await post('/areas/hyd-banjara-hills/versions', ops, {
      edgeMeters: 260,
      reason: 'now',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^A change to this area already starts at /);

    now += 60_000;
    const both = await Promise.all([
      post('/areas/hyd-jubilee-hills/versions', ops, { edgeMeters: 250, reason: 'one' }),
      post('/areas/hyd-jubilee-hills/versions', ops, { edgeMeters: 240, reason: 'two' }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(both.find((x) => x.status === 409)?.body.error).toBe(
      'Someone changed this area just now: reload the page and try again',
    );
  });
});
