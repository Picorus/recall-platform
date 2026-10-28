// P3.17: settings routes: every member sees the settings; a super admin changes one, with why; a
// stale change is refused; areas take a city from the list.
import { freshDatabase } from '@recall/db/test-db';
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
const NOW = Date.UTC(2027, 7, 23, 4, 30); // milliseconds
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: ['https://admin.test'],
  secureCookies: true,
  proxyHops: 0,
  connections: [{ service: 'Brand payments', state: 'stand-in', provider: 'fake' }],
};
const member = members(() => pool, NOW);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  server = createServer(
    apiHandler(
      pool,
      CFG,
      () => {},
      () => NOW,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

describe('settings routes (P3.17)', () => {
  it('everyone sees them; a super admin changes them; areas take a city from the list', async () => {
    const boss = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const get = async (cookie: string) => {
      const r = await fetch(`${url}/settings`, { headers: { cookie } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const post = async (
      cookie: string,
      path: string,
      body: unknown,
      origin = 'https://admin.test',
    ) => {
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const seen = await get(sana);
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({
      canChange: false,
      // 10:00 India time on a Monday: open by default.
      supportOpen: true,
      connections: [{ service: 'Brand payments', state: 'stand-in' }],
      settings: { cities: { value: [{ name: 'Hyderabad' }], version: 0 } },
    });
    expect((await fetch(`${url}/settings`)).status).toBe(401);
    const cities = {
      value: [{ name: 'Hyderabad' }, { name: 'Bengaluru' }],
      reason: 'Next city',
      version: 0,
    };
    expect((await post(sana, '/settings/cities', cities)).status).toBe(403);
    expect((await post(boss, '/settings/cities', cities, 'https://evil.test')).status).toBe(403);
    expect((await post(boss, '/settings/nothing', cities)).status).toBe(404);
    expect((await post(boss, '/settings/cities', { ...cities, version: 'x' })).status).toBe(400);
    expect(await post(boss, '/settings/cities', cities)).toMatchObject({
      status: 200,
      body: { version: 1 },
    });
    // Saved again from the old page: someone changed it meanwhile.
    expect(await post(boss, '/settings/cities', cities)).toMatchObject({ status: 409 });
    expect(
      await post(boss, '/settings/cities', {
        value: [{ name: 'Pune' }],
        reason: 'swap the city',
        version: 1,
      }),
    ).toMatchObject({
      status: 400,
      body: { error: 'Hyderabad cannot be removed (areas may use it)' },
    });
    const after = await get(boss);
    expect(after.body).toMatchObject({
      canChange: true,
      settings: { cities: { version: 1, reason: 'Next city' } },
    });
    // A new area must be in a listed city.
    const area = (city: string) => ({
      areaId: 'blr-koramangala',
      name: 'Koramangala',
      city,
      ring: [
        { lat: 12.93, lng: 77.62 },
        { lat: 12.93, lng: 77.622 },
        { lat: 12.932, lng: 77.622 },
        { lat: 12.932, lng: 77.62 },
      ],
      edgeMeters: 300,
      reason: 'Looking at Bengaluru',
    });
    expect(await post(boss, '/areas', area('Mysuru'))).toMatchObject({
      status: 400,
      body: { error: 'City: Mysuru is not in Settings (Cities)' },
    });
    expect((await post(boss, '/areas', area('Bengaluru'))).status).toBe(200);
  });

  it('the business switch (P7.7.7): a super admin flips POC or regular, with why, from a day ahead', async () => {
    const boss = await member('meena@recall.in', { role: 'super-admin', areas: [] });
    const sana = await member('ravi@recall.in', { role: 'admin', areas: ['sales'] });
    const get = async (cookie: string) =>
      (await (await fetch(`${url}/settings`, { headers: { cookie } })).json()) as {
        business: Record<string, unknown> & { history: unknown[] };
      };
    const post = async (cookie: string, body: unknown, origin = 'https://admin.test') => {
      const r = await fetch(`${url}/settings/business`, {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    // Mon 23 Aug 2027, 10:00 India time: regular business; the POC would start on 1 Sep.
    const sep1 = Date.parse('2027-09-01T08:00:00+05:30') / 1000;
    expect((await get(boss)).business).toMatchObject({
      mode: 'regular',
      next: null,
      canSwitch: true,
      pocFrom: sep1,
      history: [],
    });
    expect((await get(sana)).business).toMatchObject({ canSwitch: false });
    // Only a super admin, from the admin site, saying why.
    expect((await post(sana, { mode: 'poc', reason: 'POC starts' })).status).toBe(403);
    expect(
      (await post(boss, { mode: 'poc', reason: 'POC starts' }, 'https://evil.test')).status,
    ).toBe(403);
    expect((await post(boss, { mode: 'poc', reason: 'go' })).body).toEqual({
      error: 'Say why (a few words)',
    });
    expect((await post(boss, { mode: 'trial', reason: 'POC starts' })).status).toBe(400);
    expect((await post(boss, { mode: 'poc', reason: 'POC starts with 200 bikes' })).body).toEqual({
      mode: 'poc',
      from: sep1,
    });
    const after = (await get(boss)).business;
    expect(after).toMatchObject({ mode: 'regular', next: { mode: 'poc', from: sep1 } });
    expect(after.history).toMatchObject([
      { mode: 'poc', from: sep1, setBy: expect.any(String), reason: 'POC starts with 200 bikes' },
    ]);
    // One switch at a time: a second is refused in plain words.
    expect((await post(boss, { mode: 'regular', reason: 'changed my mind' })).status).toBe(400);
  });
});
