// The Screens page's routes: who may look and who may change; the rules' refusals as plain answers.
import { freshDatabase } from '@recall/db/test-db';
import { newScreenId } from '@recall/domain';
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
const NOW = Date.now();
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
};
const member = members(() => pool, NOW);
const SPARE = newScreenId([1, 4, 1, 4, 2, 1, 3]);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await pool.query(
    `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
     VALUES ($1, 'RK-SCR-1', 'VendorX LED28 v1', 'warehouse-1', now())`,
    [SPARE],
  );
  server = createServer(
    apiHandler(
      pool,
      CFG,
      () => {},
      () => NOW + 2000,
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
  const r = await fetch(`${url}/screens`, { headers: { cookie } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const post = async (path: string, cookie: string, body: object) => {
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('Screens page routes (P3.4)', () => {
  it('looking needs Operations; changing needs an Operations admin and a reason', async () => {
    const ops = await member('arjun@recall.in', { role: 'admin', areas: ['operations'] });
    const viewer = await member('auditor@recall.in', { role: 'read-only', areas: ['operations'] });
    const sales = await member('priya@recall.in', { role: 'admin', areas: ['sales'] });
    expect((await get(sales)).status).toBe(403);
    const seen = await get(viewer);
    expect(seen.status).toBe(200);
    expect(seen.body.counts).toEqual({
      onBike: 0,
      inStock: 1,
      inRepair: 0,
      retired: 0,
      sparesWanted: 0,
    });
    expect(seen.body.rollout).toBeNull();

    const repair = { kind: 'to-repair', reason: 'dead pixels' };
    expect((await post(`/screens/${SPARE}/service`, viewer, repair)).status).toBe(403);
    expect(
      (await post(`/screens/${SPARE}/service`, ops, { kind: 'to-repair', reason: '' })).status,
    ).toBe(400);
    expect((await post(`/screens/${SPARE}/service`, ops, repair)).status).toBe(200);
    const after = await get(ops);
    expect(after.body.counts).toMatchObject({ inStock: 0, inRepair: 1 });
    expect((after.body.screens as { serviceNote: string }[])[0]?.serviceNote).toBe('dead pixels');
    const log = await pool.query<{ by: string }>('SELECT by FROM screen_service_events');
    expect(log.rows[0]?.by).toMatch(/^arjun \(STF-[0-9a-f]{12}\)$/);
  });

  it('the rules refuse plainly (400 or 409, with why), never a server error', async () => {
    const ops = await member('kiran@recall.in', { role: 'admin', areas: ['operations'] });
    const again = await post(`/screens/${SPARE}/service`, ops, {
      kind: 'to-repair',
      reason: 'still dead',
    });
    expect(again).toEqual({ status: 400, body: { error: `${SPARE} is already in repair` } });
    expect(
      (await post(`/screens/${SPARE}/service`, ops, { kind: 'fixed', reason: 'x y z' })).status,
    ).toBe(400);
    expect((await post(`/screens/${SPARE}/unfit`, ops, { reason: 'rider left' })).body.error).toBe(
      `${SPARE} is not on a bike`,
    );
    expect(
      (await post(`/screens/${SPARE}/swap`, ops, { newScreenId: 'nope', reason: 'flicker' }))
        .status,
    ).toBe(400);
    expect((await post(`/screens/not-a-screen/unfit`, ops, { reason: 'rider left' })).status).toBe(
      404,
    );
    expect((await post('/rollout/pause', ops, { pause: true, reason: 'flicker' })).status).toBe(
      409,
    );
    expect((await post('/rollout/roll-back', ops, { reason: 'flicker' })).status).toBe(409);
    expect((await post('/rollout/pause', ops, { pause: 'yes', reason: 'flicker' })).status).toBe(
      400,
    );
  });
});
