// The "Prices and rules" page's routes: who may look and change; the first version is the plan's
// book; each change is the next version from now, with why; refused changes say why; two saves at
// once never overwrite each other; nothing is back-dated or edited.
import { priceBooks } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { PRICE_BOOK_V1, priceBookAt } from '@recall/domain';
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

interface Version {
  version: number;
  validFrom: string;
  savedBy: string;
  reason: string | null;
  changes: { setting: string; before: string; after: string }[];
  book: { adsDueDays: number; bands: { name: string; paisePerBikeHour: number }[] };
}
const get = async (cookie: string) => {
  const r = await fetch(`${url}/prices`, { headers: { cookie } });
  return {
    status: r.status,
    body: (await r.json()) as { versions: Version[]; inForce: number | null; plan: unknown },
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

describe('Prices and rules routes (P3.6)', () => {
  it('Sales and Finance look; only a super admin changes; the first version is the plan’s book', async () => {
    const sup = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const sales = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('farah@recall.in', { role: 'read-only', areas: ['finance'] });
    const ops = await member('arjun@recall.in', { role: 'admin', areas: ['operations'] });

    expect((await get(ops)).status).toBe(403);
    const empty = await get(fin);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ versions: [], inForce: null, plan: { version: 1 } });

    for (const who of [sales, fin, ops])
      expect(
        (await post('/prices', who, { baseVersion: null, change: {}, reason: 'start' })).status,
      ).toBe(403);
    // Sales may check a change (to talk it through), not save it.
    expect((await post('/prices/check', sales, { baseVersion: null, change: {} })).status).toBe(
      200,
    );

    const first = await post('/prices', sup, {
      baseVersion: null,
      change: {},
      reason: 'launch prices',
    });
    // The first version starts with the month (00:00 India time on the 1st), so monthly rules such
    // as rider pay find a book in force for the whole launch month.
    expect(first).toMatchObject({
      status: 200,
      body: { version: 1, validFrom: '2026-11-30T18:30:00.000Z' },
    });
    const one = (await get(sales)).body;
    expect(one.inForce).toBe(1);
    expect(one.plan).toBeNull();
    expect(one.versions[0]).toMatchObject({
      version: 1,
      reason: 'launch prices',
      savedBy: expect.stringContaining('prateek'),
    });
    expect((await priceBooks(pool))[0]).toEqual({
      ...PRICE_BOOK_V1,
      validFrom: '2026-11-30T18:30:00.000Z',
    });
    expect(priceBookAt(await priceBooks(pool), '2026-11-30T18:30:00.000Z')?.version).toBe(1);
  });

  it('a change: checked first, then saved as the next version from now, with what changed in words', async () => {
    const sup = await member('prateek2@recall.in', { role: 'super-admin', areas: [] });
    now += 600_000; // (sessions end after 30 idle minutes)
    const change = { prices: { Peak: 32_000 }, adsDueDays: 5 };
    const checked = await post('/prices/check', sup, { baseVersion: 1, change });
    expect(checked.body).toEqual({
      problems: [],
      changes: [
        { setting: 'Peak price a bike-hour', before: '₹300', after: '₹320' },
        {
          setting: 'Ads due',
          before: '7 days before the first hour',
          after: '5 days before the first hour',
        },
      ],
      openQuotes: 0,
    });
    expect((await priceBooks(pool)).length).toBe(1); // checking saves nothing
    const saved = await post('/prices', sup, {
      baseVersion: 1,
      change,
      reason: 'Peak demand is high',
    });
    expect(saved.status).toBe(200);
    const v = (await get(sup)).body.versions;
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    expect(v[0]).toMatchObject({
      validFrom: '2026-12-01T06:10:00.000Z',
      reason: 'Peak demand is high',
      changes: checked.body.changes,
      book: { adsDueDays: 5 },
    });
    // Sales and Finance see the selling settings only, not rider pay, cuts or taxes.
    expect(v[0]?.book).not.toHaveProperty('riderPay');
    expect(v[0]?.book).not.toHaveProperty('taxes');
    // A booking quoted before keeps version 1; one quoted now gets version 2.
    const books = await priceBooks(pool);
    expect(priceBookAt(books, '2026-12-01T06:09:59.000Z')?.version).toBe(1);
    expect(priceBookAt(books, '2026-12-01T06:10:00.000Z')?.version).toBe(2);
  });

  it('refused with the reason: below the floor, an unknown setting, a bad hour, no reason, nothing changed', async () => {
    const sup = await member('prateek3@recall.in', { role: 'super-admin', areas: [] });
    now += 60_000;
    const save = (change: object, reason = 'trying') =>
      post('/prices', sup, { baseVersion: 2, change, reason });
    expect(await save({ prices: { Lite: 20_000 } })).toMatchObject({
      status: 400,
      body: { error: 'Lite: below the floor' },
    });
    const offer = await post('/prices/check', sup, {
      baseVersion: 2,
      change: { offersBp: { 12: 2_500 } },
    });
    expect(offer.body.problems).toContain('12-month offer takes Normal below the floor');
    expect((await save({ price: 1 })).body.error).toBe('Unknown setting: price');
    expect((await save({ prices: { Gold: 40_000 } })).body.error).toBe('No band called Gold');
    expect((await save({ hourBands: { 7: 'Peak' } })).body.error).toBe(
      '7 is not a start hour (8 to 25)',
    );
    expect((await save({ hourBands: { 9: 'Gold' } })).body.error).toBe('No band called Gold');
    expect((await save({ minBikesPerLine: '5' })).body.error).toBe(
      'minBikesPerLine must be a number',
    );
    expect((await save({ minBookingPaise: 100.5 })).body.error).toBe(
      'minBookingPaise must be a whole number',
    );
    expect((await save({ adsDueDays: 6 }, ' x ')).body.error).toBe(
      'Give a reason (3 to 200 characters)',
    );
    expect((await save({ adsDueDays: 5 })).body.error).toBe('Nothing changed');
    expect((await priceBooks(pool)).length).toBe(2);
  });

  it('two saves from the same page: the second is told to reload, never overwrites', async () => {
    const sup = await member('prateek4@recall.in', { role: 'super-admin', areas: [] });
    now += 60_000;
    const a = await post('/prices', sup, {
      baseVersion: 2,
      change: { trialDays: 10 },
      reason: 'longer trial',
    });
    expect(a.status).toBe(200);
    now += 60_000;
    const b = await post('/prices', sup, {
      baseVersion: 2,
      change: { trialDays: 5 },
      reason: 'shorter trial',
    });
    expect(b).toMatchObject({ status: 409, body: { error: expect.stringContaining('reload') } });
    // Two at the same second: one wins, one is told to reload; neither is a fault.
    const both = await Promise.all([
      post('/prices', sup, { baseVersion: 3, change: { trialBikeHours: 30 }, reason: 'one' }),
      post('/prices', sup, { baseVersion: 3, change: { trialBikeHours: 40 }, reason: 'two' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await priceBooks(pool)).map((x) => x.version)).toEqual([1, 2, 3, 4]);
  });

  it('a version already starting later blocks a change now; versions cannot be edited or deleted', async () => {
    const sup = await member('prateek5@recall.in', { role: 'super-admin', areas: [] });
    const later = new Date(now + 86_400_000).toISOString();
    const books = await priceBooks(pool);
    const last = books.at(-1);
    await pool.query(
      'INSERT INTO price_books (version, valid_from, book, saved_by, reason) VALUES ($1, $2, $3, $4, $5)',
      [5, later, JSON.stringify({ ...last, version: 5, validFrom: later }), 'tool', 'planned'],
    );
    now += 60_000;
    const r = await post('/prices', sup, {
      baseVersion: 5,
      change: { trialDays: 8 },
      reason: 'now',
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('already starts at');
    expect((await get(sup)).body.inForce).toBe(4);
    await expect(pool.query('UPDATE price_books SET reason = $1', ['edited'])).rejects.toThrow();
    await expect(pool.query('DELETE FROM price_books')).rejects.toThrow();
  });
});
