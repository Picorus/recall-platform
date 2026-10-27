// P4.1: the rider app's sign-in routes: a code on WhatsApp or SMS, a bearer session, who is signed
// in, sign-out; the web build only from its own origins; limits answer 429.
import { boxRequest, freshDatabase } from '@recall/db/test-db';
import {
  fakeBankCheck,
  fakeDeviceCa,
  fakeEsign,
  fakeFileStore,
  fakeKyc,
  fakeMessages,
} from '@recall/adapters';
import { createRider, enrolScreen, openFittingSlot, stepRider } from '@recall/db';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const NOW = Date.UTC(2027, 7, 23, 4, 30); // milliseconds
const messages = fakeMessages();
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: ['https://admin.test'],
  secureCookies: true,
  proxyHops: 0,
  messages,
  riderOrigins: ['http://localhost:8081'],
  files: fakeFileStore({ baseUrl: 'http://files', secret: 's' }),
  riderChecks: {
    kyc: fakeKyc({ auto: true }),
    esign: fakeEsign({ auto: true }),
    bank: fakeBankCheck(),
  },
};

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

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    headers: r.headers,
    body: (await r.json()) as Record<string, unknown>,
  };
};
const lastCode = () => {
  const m = messages.sent.at(-1);
  return m?.channel === 'whatsapp'
    ? (m.params[0] ?? '')
    : m?.channel === 'sms'
      ? m.text.slice(0, 6)
      : '';
};

describe('rider app sign-in routes (P4.1)', () => {
  it('a code, a session, who is signed in, sign-out', async () => {
    const riderId = await createRider(
      pool,
      {
        details: {
          name: 'Ravi Kumar',
          phone: '+919848012345',
          bikePlate: null,
          rides: '',
          apps: [],
        },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      NOW / 1000 - 3600,
    );
    expect((await post('/rider/code', { phone: '12345', channel: 'whatsapp' })).status).toBe(400);
    expect((await post('/rider/code', { phone: '98480 12345', channel: 'fax' })).status).toBe(400);
    const sent = await post('/rider/code', {
      phone: '98480 12345',
      channel: 'whatsapp',
      language: 'te',
    });
    expect(sent).toMatchObject({
      status: 200,
      body: { phone: '+919848012345', shown: '+91 98480 12345' },
    });
    expect(messages.sent.at(-1)).toMatchObject({ template: 'sign_in_code', language: 'te' });
    expect((await post('/rider/sign-in', { phone: '9848012345', code: '12' })).status).toBe(400);
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    expect(await post('/rider/sign-in', { phone: '9848012345', code: wrong })).toMatchObject({
      status: 400,
      body: { error: 'Wrong code: 4 tries left', why: 'wrong-code', n: 4 },
    });
    const ok = await post('/rider/sign-in', { phone: '+91 98480 12345', code: lastCode() });
    expect(ok).toMatchObject({ status: 200, body: { riderId } });
    const token = String(ok.body.token);
    const me = await fetch(`${url}/rider/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ riderId, name: 'Ravi Kumar', status: 'applied' });
    expect((await fetch(`${url}/rider/me`)).status).toBe(401);
    expect(
      (await fetch(`${url}/rider/me`, { headers: { authorization: 'Bearer x' } })).status,
    ).toBe(401);
    expect((await post('/rider/sign-out', {}, { authorization: `Bearer ${token}` })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${url}/rider/me`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
    // The staff cookie routes are not the rider's: no way in with a rider token.
    expect(
      (await fetch(`${url}/riders`, { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(401);
  });

  it('the web build from its own origin only; too many codes is 429', async () => {
    const pre = await fetch(`${url}/rider/code`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
    expect(
      (
        await post(
          '/rider/code',
          { phone: '9000011111', channel: 'sms' },
          { origin: 'https://evil.test' },
        )
      ).status,
    ).toBe(403);
    let last = { status: 0, headers: new Headers(), body: {} as Record<string, unknown> };
    for (let i = 0; i < 4; i++)
      last = await post(
        '/rider/code',
        { phone: '9000011111', channel: 'sms', language: 'hi' },
        { origin: 'http://localhost:8081' },
      );
    expect(last.status).toBe(429);
    // Errors carry the origin header too, so the web build can show them.
    expect(last.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
    expect(String(last.body.error)).toMatch(/^Too many codes/);
  });
});

describe('rider app joining routes (P4.2)', () => {
  it('a new number signs up, sends its papers and checks; only its own record; closed once decided', async () => {
    await post('/rider/code', { phone: '9600012345', channel: 'whatsapp' });
    const ok = await post('/rider/sign-in', { phone: '9600012345', code: lastCode() });
    const auth = { authorization: `Bearer ${String(ok.body.token)}` };
    const get = async (path: string) => {
      const r = await fetch(`${url}${path}`, { headers: auth });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect(await get('/rider/join')).toMatchObject({ status: 404, body: { why: 'not-joined' } });
    expect(
      (await post('/rider/join', { name: 'Ramesh', rides: 'x', apps: ['nope'] }, auth)).status,
    ).toBe(400);
    const joined = await post(
      '/rider/join',
      { name: 'Ramesh Naidu', rides: 'Ameerpet', apps: ['zomato'], bikePlate: null },
      auth,
    );
    expect(joined.status).toBe(200);
    const riderId = String(joined.body.riderId);
    expect(
      (await post('/rider/join', { name: 'Ramesh Naidu', rides: '', apps: [] }, auth)).status,
    ).toBe(400);
    const page = await get('/rider/join');
    expect(page.body).toMatchObject({ riderId, canChange: true, loanBank: 'Dhanlaxmi Bank' });
    // A picture as the body.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3,
    ]);
    const up = await fetch(`${url}/rider/documents?kind=photo`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: png,
    });
    expect(up.status).toBe(200);
    const pdfPhoto = await fetch(`${url}/rider/documents?kind=photo`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode('%PDF-1.4 hello'),
    });
    expect(pdfPhoto.status).toBe(400);
    const id1 = (await post('/rider/identity', {}, auth)).body.link;
    expect(id1).toMatch(/^https:/);
    // Still waiting: the same link again, nothing new started (each check costs).
    expect((await post('/rider/identity', {}, auth)).body.link).toBe(id1);
    // An account in someone else's name: never told whose it is.
    expect(
      (await post('/rider/bank', { kind: 'upi', vpa: 'other@okaxis', name: 'Anita Sharma' }, auth))
        .body,
    ).toEqual({ outcome: 'failed', reason: 'the name on the account is not yours' });
    expect((await post('/rider/checks', {}, auth)).body).toEqual({ answered: 1 });
    expect(
      (await post('/rider/bank', { kind: 'upi', vpa: 'ramesh@okaxis', name: 'Ramesh Naidu' }, auth))
        .body,
    ).toMatchObject({ outcome: 'passed' });
    const after = await get('/rider/join');
    expect((after.body.steps as { state: string }[]).map((x) => x.state)).toEqual([
      'waiting',
      'todo',
      'done',
      'done',
      'todo',
      'later',
    ]);
    // Without a session, nothing.
    expect((await fetch(`${url}/rider/join`)).status).toBe(401);
    // Decided: no more changes from the app.
    await stepRider(pool, riderId, 'rejected', 'Omar', 'not in our area', NOW / 1000);
    expect(await post('/rider/agreement', {}, auth)).toMatchObject({
      status: 409,
      body: { why: 'decided' },
    });
    expect(
      (await post('/rider/profile', { name: 'Ramesh Naidu', rides: 'x', apps: [] }, auth)).status,
    ).toBe(400);
  });
});

describe('rider app fitting routes (P4.3)', () => {
  it('books, fits at his slot, starts the check, answers the panel; staff see the check', async () => {
    const now = NOW / 1000;
    const riderId = await createRider(
      pool,
      {
        details: {
          name: 'Kiran Rao',
          phone: '+919600054321',
          bikePlate: 'TS08CD4321',
          rides: 'Kondapur',
          apps: [],
        },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      now - 7200,
    );
    await pool.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       VALUES ($1, 2, 'approved', 'all checked', 'Omar', to_timestamp($2))`,
      [riderId, now - 3600],
    );
    await pool.query(
      `INSERT INTO settings (key, version, value, saved_by, reason)
       VALUES ('fittingCentres', 1, $1, 'Prateek', 'the first centre')`,
      [JSON.stringify([{ name: 'Madhapur hub', address: 'Plot 5', on: true }])],
    );
    const slotId = await openFittingSlot(
      pool,
      { centre: 'Madhapur hub', startsAt: now + 600, minutes: 60, bikes: 4, by: 'Omar' },
      now - 3600,
    );
    const box = await enrolScreen(
      pool,
      fakeDeviceCa(),
      boxRequest('RK-API-FIT', now - 3600),
      'w',
      now - 3600,
    );
    await post('/rider/code', { phone: '9600054321', channel: 'whatsapp' });
    const ok = await post('/rider/sign-in', { phone: '9600054321', code: lastCode() });
    const auth = { authorization: `Bearer ${String(ok.body.token)}` };
    const get = async (path: string) => {
      const r = await fetch(`${url}${path}`, { headers: auth });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect((await get('/rider/fitting')).body).toMatchObject({
      status: 'approved',
      booking: null,
      slots: [{ slotId, centre: 'Madhapur hub', address: 'Plot 5', left: 4 }],
    });
    expect((await post('/rider/fitting/book', { slotId }, auth)).status).toBe(200);
    expect(await post('/rider/fitting/fit', { code: 'RECALL1:nope' }, auth)).toMatchObject({
      status: 400,
      body: { why: 'not-a-screen' },
    });
    expect(await post('/rider/fitting/fit', { code: box.qr }, auth)).toMatchObject({
      status: 200,
      body: { screenId: box.screenId },
    });
    const check = await post('/rider/fitting/check', {}, auth);
    expect(check.status).toBe(200);
    const commandId = String(check.body.commandId);
    expect((await post('/rider/fitting/panel', { commandId, seen: 'yes' }, auth)).status).toBe(400);
    expect((await post('/rider/fitting/panel', { commandId, seen: true }, auth)).status).toBe(200);
    expect((await get('/rider/fitting')).body).toMatchObject({
      screenId: box.screenId,
      check: { commandId, panel: 'ok', gps: 'waiting', ready: false },
    });
    expect((await post('/rider/fitting/nope', {}, auth)).status).toBe(404);
  });
});
