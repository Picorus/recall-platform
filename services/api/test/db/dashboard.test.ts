// P3.14.2: the dashboard route: Sales and Finance look; others do not; months checked.
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

describe('dashboard route (P3.14.2)', () => {
  it('Sales and Finance look; months are checked; this month by default', async () => {
    const ops = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const sales = await member('lata@recall.in', { role: 'read-only', areas: ['sales'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    expect((await get(ops, '/dashboard')).status).toBe(403);
    const d = (await (await get(sales, '/dashboard')).json()) as { months: { month: string }[] };
    expect(d.months.map((m) => m.month)).toEqual([
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
      '2027-08',
    ]);
    expect((await get(sales, '/dashboard?month=2027-02&count=2')).status).toBe(200);
    expect((await get(sales, '/dashboard?month=2027-13')).status).toBe(400);
    expect((await get(sales, '/dashboard?count=99')).status).toBe(400);
  });

  it('the charts: today hour by hour and the last days (P7.7.7)', async () => {
    const ops = await member('omar2@recall.in', { role: 'admin', areas: ['operations'] });
    const finance = await member('fara@recall.in', { role: 'read-only', areas: ['finance'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    expect((await get(ops, '/dashboard/trends')).status).toBe(403);
    const t = (await (await get(finance, '/dashboard/trends?days=14')).json()) as {
      day: string;
      hours: { hour: number }[];
      days: { day: string }[];
    };
    expect(t.day).toBe('2027-08-23');
    expect(t.hours).toHaveLength(18);
    expect(t.days).toHaveLength(14);
    expect(t.days.at(-1)?.day).toBe('2027-08-23');
    expect((await get(finance, '/dashboard/trends')).status).toBe(200);
    expect((await get(finance, '/dashboard/trends?days=0')).status).toBe(400);
    expect((await get(finance, '/dashboard/trends?days=91')).status).toBe(400);
    expect((await get(finance, '/dashboard/trendsx')).status).toBe(404);
  });
});
