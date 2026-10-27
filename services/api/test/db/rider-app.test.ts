// P4.1: the rider app's sign-in routes: a code on WhatsApp or SMS, a bearer session, who is signed
// in, sign-out; the web build only from its own origins; limits answer 429.
import { freshDatabase } from '@recall/db/test-db';
import { fakeMessages } from '@recall/adapters';
import { createRider } from '@recall/db';
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
