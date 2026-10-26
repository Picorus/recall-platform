// The fleet map's routes: who may look, who may send a command, and what is refused.
import { freshDatabase } from '@recall/db/test-db';
import { newScreenId, parseCommand } from '@recall/domain';
import { pendingCommands } from '@recall/db';
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
const SCREEN = newScreenId([3, 1, 4, 1, 5, 9, 2]);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await pool.query(
    `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
     VALUES ($1, 'RK-API-1', 'VendorX LED28 v1', 'warehouse-1', now())`,
    [SCREEN],
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

const get = async (path: string, cookie: string) =>
  (await fetch(url + path, { headers: { cookie } })).status;
const post = async (path: string, cookie: string, body: object) => {
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe('fleet map routes (P3.3)', () => {
  it('looking needs Operations; sending a command needs an Operations admin', async () => {
    const sup = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('arjun@recall.in', { role: 'admin', areas: ['operations'] });
    const viewer = await member('auditor@recall.in', { role: 'read-only', areas: ['operations'] });
    const sales = await member('priya@recall.in', { role: 'admin', areas: ['sales'] });
    expect(await get('/fleet', sup)).toBe(200);
    expect(await get('/fleet', ops)).toBe(200);
    expect(await get('/fleet', viewer)).toBe(200);
    expect(await get('/fleet', sales)).toBe(403);
    expect(await get(`/fleet/screens/${SCREEN}`, viewer)).toBe(200);
    expect(await get(`/fleet/screens/${SCREEN}`, sales)).toBe(403);

    const cmd = { command: 'blank', value: null, reason: 'rider asked' };
    expect((await post(`/fleet/screens/${SCREEN}/commands`, viewer, cmd)).status).toBe(403);
    expect((await post(`/fleet/screens/${SCREEN}/commands`, sales, cmd)).status).toBe(403);
    const ok = await post(`/fleet/screens/${SCREEN}/commands`, ops, cmd);
    expect(ok.status).toBe(200);
    // A second click: the same command, not a second one.
    const twice = await post(`/fleet/screens/${SCREEN}/commands`, ops, cmd);
    expect(twice.body).toEqual({ id: ok.body.id, repeated: true });
    // Logged with who and why, waiting for the screen.
    const waiting = await pendingCommands(pool, SCREEN, NOW + 3000);
    expect(waiting.map((t) => parseCommand(t))).toEqual([
      expect.objectContaining({ id: ok.body.id, do: 'blank', screen: SCREEN }),
    ]);
    const log = await pool.query<{ by: string; reason: string }>(
      'SELECT by, reason FROM screen_commands',
    );
    expect(log.rows).toEqual([
      { by: expect.stringMatching(/^arjun \(STF-[0-9a-f]{12}\)$/), reason: 'rider asked' },
    ]);
  });

  it('refused: an unknown command, the fitter-only check, a bad value, no reason, an unknown screen', async () => {
    const ops = await member('kiran@recall.in', { role: 'admin', areas: ['operations'] });
    const path = `/fleet/screens/${SCREEN}/commands`;
    expect((await post(path, ops, { command: 'self-destruct', reason: 'test' })).status).toBe(400);
    expect(
      (await post(path, ops, { command: 'fitting-check', value: 60, reason: 'test' })).status,
    ).toBe(400);
    expect(
      (await post(path, ops, { command: 'brightness', value: 140, reason: 'too bright' })).status,
    ).toBe(400);
    expect(
      (await post(path, ops, { command: 'brightness', value: 1.5, reason: 'too bright' })).status,
    ).toBe(400);
    expect((await post(path, ops, { command: 'reboot', reason: '' })).status).toBe(400);
    expect(
      (
        await post(`/fleet/screens/${newScreenId([9, 9, 9, 9, 9, 9, 9])}/commands`, ops, {
          command: 'reboot',
          reason: 'stuck',
        })
      ).status,
    ).toBe(404);
    expect(await get('/fleet/screens/not-a-screen', ops)).toBe(404);
  });

  it('the map gets the areas sold now and the commands staff may send', async () => {
    const ops = await member('lata@recall.in', { role: 'admin', areas: ['operations'] });
    const r = await fetch(`${url}/fleet`, { headers: { cookie: ops } });
    const b = (await r.json()) as {
      screens: { screenId: string; state: string }[];
      areas: unknown[];
      commands: string[];
    };
    expect(b.screens).toEqual([expect.objectContaining({ screenId: SCREEN, state: 'at-hub' })]);
    expect(b.areas).toEqual([]);
    expect(b.commands).not.toContain('fitting-check');
    expect(b.commands).toContain('reboot');
  });
});
