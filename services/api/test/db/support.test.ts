// P3.15: support routes: the provider's signed post comes in (a forged one is refused); Support looks
// (read-only members see phones masked) and Support admins answer: reply, note, pick up, done; others
// do not.
import { fakeInbound, fakeMaps, fakeMessages } from '@recall/adapters';
import { createRider } from '@recall/db';
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
const ORIGIN = 'https://admin.test';
const inbound = fakeInbound();
const messages = fakeMessages();
const member = members(() => pool, NOW);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone: '+919848012345', bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Sunita',
      reason: 'walk-in',
    },
    NOW / 1000,
  );
  const cfg: StaffApiConfig = {
    secretKey: randomBytes(32),
    origins: [ORIGIN],
    secureCookies: true,
    proxyHops: 0,
    inbound,
    reports: { maps: fakeMaps(), messages, portalUrl: 'https://brand.test' },
  };
  server = createServer(
    apiHandler(
      pool,
      cfg,
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

describe('support routes (P3.15)', () => {
  it('a message comes in; Support looks and answers', async () => {
    const post = inbound.message({
      channel: 'whatsapp',
      providerId: 'wamid.1',
      from: '+919848012345',
      text: 'Screen off',
      at: NOW / 1000,
    });
    const forged = await fetch(`${url}/support/inbound`, {
      method: 'POST',
      headers: { 'x-message-signature': 'f'.repeat(64) },
      body: post.body,
    });
    expect(forged.status).toBe(401);
    const ok = await fetch(`${url}/support/inbound`, {
      method: 'POST',
      headers: { 'x-message-signature': post.signature },
      body: post.body,
    });
    const { threadId } = (await ok.json()) as { threadId: string };
    expect(threadId).toMatch(/^SUP-/);

    const ops = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const look = await member('lata@recall.in', { role: 'read-only', areas: ['support'] });
    const sup = await member('sunita@recall.in', { role: 'admin', areas: ['support'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    const send = (cookie: string, path: string, body: object) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await get(ops, '/support')).status).toBe(403);
    const seen = (await (await get(look, '/support')).json()) as {
      rows: { contact: string; party: { name: string } }[];
      canAct: boolean;
    };
    expect(seen).toMatchObject({
      canAct: false,
      rows: [{ contact: '+91 ••••••2345', party: { name: 'Ravi Kumar' } }],
    });
    expect((await send(look, `/support/${threadId}/note`, { text: 'hi' })).status).toBe(403);
    expect(
      await (await send(sup, `/support/${threadId}/reply`, { text: 'Coming to fix it' })).json(),
    ).toEqual({
      status: 'sent',
    });
    expect(messages.sent).toMatchObject([
      {
        channel: 'whatsapp',
        to: '+919848012345',
        template: 'support_reply',
        params: ['Coming to fix it'],
      },
    ]);
    expect((await send(sup, `/support/${threadId}/note`, { text: 'Fixed the cable' })).status).toBe(
      200,
    );
    expect(
      (
        await send(sup, `/support/${threadId}/step`, {
          state: 'done',
          owner: 'me',
          reason: 'fixed',
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(sup, `/support/${threadId}/step`, { state: 'closed', owner: null, reason: 'x' }))
        .status,
    ).toBe(400);
    expect((await send(sup, '/support/SUP-0000000000/note', { text: 'x' })).status).toBe(404);
    const page = (await (await get(sup, `/support/${threadId}`)).json()) as {
      state: string;
      contact: string;
      timeline: { kind: string }[];
    };
    expect(page.state).toBe('done');
    // A read-only member never sees the phone in full, not even in the history.
    const lookPage = await (await get(look, `/support/${threadId}`)).text();
    expect(lookPage).not.toContain('9848012345');
    expect(lookPage).toContain('+91 ••••••2345');
    expect(page.contact).toBe('+919848012345');
    expect(page.timeline.map((e) => e.kind)).toEqual(['step', 'in', 'out', 'note', 'step']);
    const opened = await send(sup, '/support/open', {
      channel: 'phone',
      contact: '+919000011111',
      subject: 'Wants to join',
      note: 'Asked about pay',
    });
    expect(opened.status).toBe(200);
    expect((await get(sup, '/support?state=done')).status).toBe(200);
    expect((await get(sup, '/support?party=rider:RD-000001')).status).toBe(200);
    expect((await get(sup, '/support?party=nobody')).status).toBe(400);
  });
});
