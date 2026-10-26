// P3.12: payout run routes: finance looks (read-only members see UPI ids masked); finance admins
// prepare, approve (someone else than who prepared), hold, release, send and drop; nothing is sent
// without a payout provider.
import { fakePayouts } from '@recall/adapters';
import {
  assignScreen,
  monthBounds,
  saveAreaVersion,
  savePriceBook,
  setBusinessMode,
} from '@recall/db';
import { checkedPayoutAccount, freshDatabase } from '@recall/db/test-db';
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
const servers: Server[] = [];
let url = '';
let bare = '';
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const now = ist('2027-08-09T11:00:00') * 1000;
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
};
const provider = fakePayouts();
const member = members(() => pool, now);

const listen = async (cfg: StaffApiConfig) => {
  const s = createServer(
    apiHandler(
      pool,
      cfg,
      () => {},
      () => now,
    ),
  );
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await setBusinessMode(
    pool,
    'poc',
    { id: 'prateek', role: 'super-admin' },
    'POC starts',
    ist('2027-07-20T12:00:00'),
  );
  for (const r of ['RD-000701', 'RD-000702'])
    await assignScreen(pool, `scr-${r}`, r, monthBounds('2027-08').start, 'fitter');
  await checkedPayoutAccount(pool, 'RD-000701', {
    kind: 'upi',
    vpa: '9848012345@okbank',
    name: 'RD-000701',
  });
  await checkedPayoutAccount(pool, 'RD-000702', {
    kind: 'upi',
    vpa: 'ravi@okaxis',
    name: 'RD-000702',
  });
  url = await listen({ ...CFG, payouts: provider });
  bare = await listen(CFG);
}, 120_000);
afterAll(async () => {
  for (const s of servers) await new Promise<void>((ok) => s.close(() => ok()));
  await db.drop();
});

describe('payout routes (P3.12)', () => {
  it('finance looks and works the run; nothing is sent twice or without a provider', async () => {
    const ops = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const look = await member('lata@recall.in', { role: 'read-only', areas: ['finance'] });
    const finA = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const finB = await member('meena@recall.in', { role: 'admin', areas: ['finance'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });
    const post = (cookie: string, path: string, body: object = {}, at = url) =>
      fetch(`${at}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const RUN = '/payouts/run/2027-08-09';

    expect((await get(ops, '/payouts')).status).toBe(403);
    const list = (await (await get(look, '/payouts')).json()) as Record<string, unknown>;
    expect(list).toMatchObject({
      runs: [],
      lastMonday: '2027-08-09',
      dueNow: '2027-08-09',
      canAct: false,
      canSend: true,
    });
    expect((await post(look, '/payouts/prepare', { monday: '2027-08-09' })).status).toBe(403);
    expect((await post(finA, '/payouts/prepare', { monday: '2027-08-10' })).status).toBe(400);
    const noOrigin = await fetch(`${url}/payouts/prepare`, {
      method: 'POST',
      headers: { cookie: finA, 'content-type': 'application/json' },
      body: JSON.stringify({ monday: '2027-08-09' }),
    });
    expect(noOrigin.status).toBe(403);

    const prepared = await post(finA, '/payouts/prepare', { monday: '2027-08-09' });
    expect(await prepared.json()).toEqual({ runId: '2027-08-09', lines: 2 });
    expect((await post(finA, '/payouts/prepare', { monday: '2027-08-09' })).status).toBe(409);
    // Whoever prepared it cannot approve it; someone else can, once.
    expect((await post(finA, `${RUN}/approve`)).status).toBe(400);
    expect((await post(finB, `${RUN}/approve`)).status).toBe(200);
    expect((await post(finB, `${RUN}/approve`)).status).toBe(409);

    expect(
      (await post(finA, `${RUN}/hold`, { riderId: 'RD-000701', held: true, reason: 'checking' }))
        .status,
    ).toBe(200);
    expect((await post(finA, `${RUN}/hold`, { riderId: 'RD-000701', held: 'yes' })).status).toBe(
      400,
    );
    // Without a payout provider nothing is sent.
    expect((await post(finA, `${RUN}/send`, {}, bare)).status).toBe(503);
    const sent = (await (await post(finA, `${RUN}/send`)).json()) as Record<string, unknown>;
    expect(sent).toMatchObject({ paid: ['RD-000702'], held: ['RD-000701'] });

    // A read-only member sees a UPI id's bank only.
    const seen = (await (await get(look, RUN)).json()) as {
      rows: { riderId: string; to: string; state: string }[];
      canAct: boolean;
    };
    expect(seen.canAct).toBe(false);
    expect(seen.rows.map((r) => [r.riderId, r.to, r.state])).toEqual([
      ['RD-000701', 'UPI ••••@okbank · RD-000701', 'held'],
      ['RD-000702', 'UPI ••••@okaxis · RD-000702', 'paid'],
    ]);
    const full = (await (await get(finA, RUN)).json()) as { rows: { to: string }[] };
    expect(full.rows[0]?.to).toBe('UPI 9848012345@okbank · RD-000701');

    expect(
      (await post(finA, `${RUN}/hold`, { riderId: 'RD-000701', held: false, reason: 'fine' }))
        .status,
    ).toBe(200);
    expect(await (await post(finA, `${RUN}/send`)).json()).toMatchObject({
      paid: ['RD-000701'],
    });
    expect(provider.sent).toHaveLength(2);
    expect(
      (await post(finA, `${RUN}/drop`, { riderId: 'RD-000702', reason: 'too late now' })).status,
    ).toBe(409);
    expect((await post(finA, `${RUN}/drop`, { riderId: 'nobody', reason: 'x' })).status).toBe(400);

    expect((await get(finA, '/payouts/run/2027-08-02')).status).toBe(404);
    expect((await post(finA, '/payouts/run/2027-08-02/approve')).status).toBe(404);
    const runs = (await (await get(finA, '/payouts')).json()) as {
      runs: { runId: string; states: Record<string, number> }[];
      canAct: boolean;
    };
    expect(runs.canAct).toBe(true);
    expect(runs.runs).toMatchObject([{ runId: '2027-08-09', states: { paid: 2 } }]);
  });
});
