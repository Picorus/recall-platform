// GET /today: every signed-in member may open it; each part only when their areas cover it.
import { acceptInvite, addStaff, signIn } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import type { StaffAccess } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newToken, tokenHash } from '../../src/secrets.js';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const NOW = 1_850_000_000_000;
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: ['https://admin.test'],
  secureCookies: true,
  proxyHops: 0,
};

let superId = '';
/** A member with this access, signed in: their session cookie. */
async function member(email: string, access: StaffAccess): Promise<string> {
  const invite = newToken();
  const m = await addStaff(pool, {
    email,
    name: email.split('@')[0] ?? 'x',
    access,
    byId: superId || 'setup',
    reason: 'today test',
    invite: { tokenHash: tokenHash(invite), totpSealed: 'unused', untilMs: NOW + 3_600_000 },
    nowMs: NOW,
  });
  if (!superId) superId = m.id;
  await acceptInvite(pool, {
    tokenHash: tokenHash(invite),
    passwordHash: 'scrypt$test',
    totpStep: 0,
    nowMs: NOW,
  });
  const session = newToken();
  const r = await signIn(pool, {
    email,
    ip: '192.0.2.1',
    agent: 'test',
    sessionHash: tokenHash(session),
    nowMs: NOW + 1000,
    check: async () => ({ passwordOk: true, step: 1 }),
  });
  expect(r.ok).toBe(true);
  return `__Host-recall_staff=${session}`;
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
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

const today = async (cookie?: string) => {
  const r = await fetch(`${url}/today`, { headers: cookie ? { cookie } : {} });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const parts = (b: Record<string, unknown>) =>
  ['fleet', 'alerts', 'hours', 'makeUps', 'refunds'].filter((k) => b[k] !== undefined);

describe('GET /today (P3.2)', () => {
  it('each member sees the parts their areas cover', async () => {
    const sup = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const ops = await member('arjun@recall.in', { role: 'admin', areas: ['operations'] });
    const sales = await member('priya@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('meena@recall.in', { role: 'read-only', areas: ['finance'] });
    const review = await member('ravi@recall.in', { role: 'admin', areas: ['ad-review'] });
    expect(parts((await today(sup)).body)).toEqual([
      'fleet',
      'alerts',
      'hours',
      'makeUps',
      'refunds',
    ]);
    expect(parts((await today(ops)).body)).toEqual([
      'fleet',
      'alerts',
      'hours',
      'makeUps',
      'refunds',
    ]);
    expect(parts((await today(sales)).body)).toEqual(['hours', 'makeUps', 'refunds']);
    expect(parts((await today(fin)).body)).toEqual(['refunds']);
    expect(parts((await today(review)).body)).toEqual([]);
  });

  it('an empty business: zeros, not errors', async () => {
    const sup = await member('second@recall.in', { role: 'super-admin', areas: [] });
    const b = (await today(sup)).body;
    expect(b.fleet).toEqual({ moving: 0, stopped: 0, offline: 0, atHub: 0, total: 0 });
    expect(b.makeUps).toEqual([]);
    expect(b.alerts).toEqual({ total: 0, list: [] });
    expect(b.hours).toMatchObject({ soldBikeHours: 0, deliveredBikeHours: 0 });
  });

  it('not signed in: 401', async () => {
    expect((await today()).status).toBe(401);
  });
});
