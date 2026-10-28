// The Brands page's routes: who may look and change; accounts opened and changed with why;
// contact, tax details and notes; refusals in words.
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

const get = async (path: string, cookie: string) => {
  const r = await fetch(url + path, { headers: { cookie } });
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

describe('Brands page routes (P3.8.1)', () => {
  it('Sales, Finance and Support look; only a Sales admin opens and changes accounts', async () => {
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const sup = await member('suresh@recall.in', { role: 'read-only', areas: ['support'] });
    const ops = await member('olu@recall.in', { role: 'admin', areas: ['operations'] });
    expect((await get('/brands', ops)).status).toBe(403);
    expect((await get('/brands', sup)).status).toBe(200);
    const agency = { brandId: 'adwise', kind: 'agency', name: 'Adwise Media', reason: 'signed' };
    for (const who of [fin, sup, ops])
      expect((await post('/brands', who, agency)).status).toBe(403);
    expect(await post('/brands', sana, agency)).toMatchObject({
      status: 200,
      body: { brandId: 'adwise' },
    });
    const brand = {
      brandId: 'chai-co',
      kind: 'brand',
      name: 'Chai Co',
      agencyId: 'adwise',
      referredBy: 'rapido',
      reason: 'first call',
    };
    expect((await post('/brands', sana, brand)).status).toBe(200);
    // Refused with why.
    expect((await post('/brands', sana, brand)).body.error).toBe('The id chai-co is taken');
    expect(
      (await post('/brands', sana, { ...brand, brandId: 'x-co', agencyId: 'chai-co' })).body.error,
    ).toBe('chai-co is a brand, not an agency');
    expect((await post('/brands', sana, { ...brand, brandId: 'Chai Co' })).body.error).toBe(
      'id: lower case letters, digits and dashes',
    );
    expect(
      (await post('/brands', sana, { ...brand, brandId: 'y-co', kind: 'shop' })).body.error,
    ).toBe('kind must be brand or agency');
    expect(
      (await post('/brands', sana, { ...brand, brandId: 'z-co', reason: 'x' })).body.error,
    ).toBe('Give a reason (3 to 200 characters)');
    const list = (await get('/brands', fin)).body.accounts as {
      brandId: string;
      agencyName: string | null;
    }[];
    expect(list.map((a) => [a.brandId, a.agencyName])).toEqual([
      ['adwise', null],
      ['chai-co', 'Adwise Media'],
    ]);
  });

  it('details change as versions (a stale page is told to reload); contact, tax and notes', async () => {
    const sana = await member('sana2@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('farah2@recall.in', { role: 'admin', areas: ['finance'] });
    const change = {
      baseVersion: 1,
      name: 'Chai Company',
      agencyId: '',
      referredBy: ' rapido ',
      active: true,
      reason: 'now books direct',
    };
    expect(await post('/brands/chai-co', sana, change)).toMatchObject({
      status: 200,
      body: { version: 2 },
    });
    expect((await post('/brands/chai-co', sana, change)).status).toBe(409);
    // Typed with stray spaces, without +91: kept in one form.
    expect(
      (
        await post('/brands/chai-co/contact', sana, {
          phone: '98765 43210 ',
          email: ' Ops @Chai.in',
        })
      ).status,
    ).toBe(200);
    expect((await post('/brands/chai-co/contact', sana, { phone: '12345' })).body.error).toBe(
      'phone must be +91 and a 10-digit mobile number',
    );
    const tax = { legalName: 'Chai Co Pvt Ltd', gstin: ' 36 aapfu 0939 f1zw ', stateCode: '36' };
    expect((await post('/brands/chai-co/tax', sana, tax)).status).toBe(200);
    expect((await post('/brands/chai-co/tax', fin, { ...tax, stateCode: '29' })).body.error).toBe(
      'The GSTIN belongs to another state',
    );
    expect((await post('/brands/chai-co/notes', sana, { note: 'Wants evenings' })).status).toBe(
      200,
    );
    expect((await post('/brands/chai-co/notes', fin, { note: 'x' })).status).toBe(403);
    expect((await post('/brands/nobody/notes', sana, { note: 'x' })).status).toBe(404);
    const page = (await get('/brands/chai-co', fin)).body as {
      account: { name: string; agencyId: string | null; version: number };
      contact: { phone: string; email: string };
      tax: { gstin: string; by: string };
      notes: { note: string }[];
      history: { reason: string }[];
    };
    expect(page.account).toMatchObject({ name: 'Chai Company', agencyId: null, version: 2 });
    expect(page.contact).toMatchObject({ phone: '+919876543210', email: 'ops@chai.in' });
    expect(page.tax).toMatchObject({
      gstin: '36AAPFU0939F1ZW',
      by: expect.stringContaining('sana2'),
    });
    expect(page.notes.map((n) => n.note)).toEqual(['Wants evenings']);
    expect(page.history.map((h) => h.reason)).toEqual(['now books direct', 'first call']);
    expect((await get('/brands/nobody', fin)).status).toBe(404);
  });
});
