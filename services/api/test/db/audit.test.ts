// P3.16: the audit route: a super admin only; searched by words, part and dates; page by page; a file.
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

describe('audit route (P3.16)', () => {
  it('a super admin searches the log; nobody else sees it', async () => {
    const boss = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    expect((await get(fin, '/audit')).status).toBe(403);
    // Adding the members is in the log: staff added, access set.
    const all = (await (await get(boss, '/audit?area=staff')).json()) as {
      rows: { area: string; action: string; who: string }[];
      next: string | null;
    };
    expect(all.rows.map((r) => r.action)).toContain('staff added');
    expect(all.rows.every((r) => r.area === 'staff')).toBe(true);
    const found = (await (await get(boss, '/audit?q=farah')).json()) as { rows: unknown[] };
    expect(found.rows.length).toBeGreaterThan(0);
    expect((await get(boss, '/audit?area=nothing')).status).toBe(400);
    expect((await get(boss, '/audit?from=2027-02-30')).status).toBe(400);
    expect((await get(boss, '/audit?before=x')).status).toBe(400);
    const none = (await (await get(boss, '/audit?to=2027-01-01')).json()) as { rows: unknown[] };
    expect(none.rows).toEqual([]);
    const file = (await (await get(boss, '/audit/export?area=staff')).json()) as { csv: string };
    expect(file.csv).toContain('staff added');
  });
});
