// Booking for a brand (P3.8.2): who may book, send for payment, cancel and add notes; the payment
// provider's signed message; refusals in words.
import { fakePayments } from '@recall/adapters';
import { createAccount, saveAreaVersion, savePriceBook } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
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
const now = Date.UTC(2027, 7, 23, 4, 30); // Mon 23 Aug 2027, 10:00 India time
const payments = fakePayments({ clock: () => Math.floor(now / 1000) });
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
  payments,
};
const member = members(() => pool, now);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createAccount(
    pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'test',
      reason: 'route test',
    },
    Math.floor(now / 1000),
  );
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
const lines = (date: string) => [
  { areaId: 'hyd-madhapur', date, startHour: 19, bikes: 30 },
  { areaId: 'hyd-madhapur', date, startHour: 20, bikes: 30 },
];

describe('booking for a brand (P3.8.2)', () => {
  it('a Sales admin books for a brand (last-minute too), sends the link; the signed message pays it', async () => {
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const ops = await member('olu@recall.in', { role: 'admin', areas: ['operations'] });
    const req = { brandId: 'chai-co', lines: lines('2027-08-23'), repeatMonths: 1 };
    expect((await post('/bookings', fin, req)).status).toBe(403);
    const made = await post('/bookings', sana, req);
    // Today, 7 pm: staff can book last-minute (the 15 days are for the portal).
    expect(made).toMatchObject({
      status: 200,
      body: {
        bookingId: expect.stringMatching(/^BK-/),
        subtotal: 1_800_000,
        gst: 324_000,
        total: 2_124_000,
      },
    });
    const id = String(made.body.bookingId);
    const sent = await post(`/bookings/${id}/send`, sana, {});
    expect(sent.body).toMatchObject({
      url: expect.stringMatching(/^https:\/\//),
      amountPaise: 2_124_000,
    });
    const msg = payments.pay(String(sent.body.linkId));
    const hook = async (signature: string) =>
      fetch(`${url}/payments/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
        body: msg.body,
      });
    expect((await hook('0'.repeat(64))).status).toBe(401);
    const ok = await hook(msg.signature);
    expect(await ok.json()).toEqual({ ok: true, outcome: 'paid' });
    expect((await get(`/bookings/${id}`, ops)).status).toBe(403);
    const v = await get(`/bookings/${id}`, fin);
    expect(v.body).toMatchObject({
      brandName: 'Chai Co',
      booking: { state: 'paid', totalPaise: 2_124_000 },
    });
  });

  it('refusals in words: no such brand, below the minimum, a past hour; cancel needs a reason', async () => {
    const sana = await member('sana2@recall.in', { role: 'admin', areas: ['sales'] });
    const base = { brandId: 'chai-co', lines: lines('2027-08-27'), repeatMonths: 1 };
    expect((await post('/bookings', sana, { ...base, brandId: 'chai-c0' })).body.error).toBe(
      'No brand chai-c0: open it on the Brands page first',
    );
    expect(
      (await post('/bookings', sana, { ...base, lines: [{ ...base.lines[0], bikes: 5 }] })).body
        .error,
    ).toBe('the minimum booking is ₹15,000 before GST');
    expect(
      (await post('/bookings', sana, { ...base, lines: lines('2027-08-22') })).body.error,
    ).toBe('the first hour has already started');
    expect((await post('/bookings', sana, { ...base, lines: [] })).body.error).toBe(
      'Give 1 to 500 lines',
    );
    const made = await post('/bookings', sana, base);
    const id = String(made.body.bookingId);
    expect(
      (await post(`/bookings/${id}/notes`, sana, { note: 'Wants a Saturday too' })).status,
    ).toBe(200);
    expect((await post(`/bookings/${id}/cancel`, sana, { reason: 'x' })).body.error).toBe(
      'Give a reason (3 to 200 characters)',
    );
    expect(
      (await post(`/bookings/${id}/cancel`, sana, { reason: 'client changed plans' })).status,
    ).toBe(200);
    expect((await post(`/bookings/${id}/send`, sana, {})).body.error).toBe(
      'This booking is cancelled: no payment link is needed',
    );
    const v = await get(`/bookings/${id}`, sana);
    const texts = (v.body.booking as { timeline: { text: string }[] }).timeline.map((t) => t.text);
    // All in the same second here: steps come before notes made at the same moment.
    expect(texts).toEqual([
      'Draft made',
      'Cancelled: client changed plans',
      'Wants a Saturday too',
    ]);
    expect((await get('/bookings/BK-NOPE', sana)).status).toBe(404);
  });
});
