// P7.8: the POC package over HTTP. Staff: Sales (and super admins) manage POC brands; Finance looks;
// others see nothing. Brands: a POC brand sees and pays only its own months; others get a 404. The
// switch back: refused as early before the planned end unless confirmed; super admins are alerted.
import { fakeMessages, fakePayments } from '@recall/adapters';
import { createAccount, savePriceBook, setBusinessMode, setPortalMember } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { pocMonthWindow, PRICE_BOOK_V1 } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';
import { members } from './members.js';

/** India time, as UTC seconds. */
const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const ADMIN = 'https://admin.test';
const PORTAL = 'https://book.recall.test';
const SUPER = { id: 'prateek', role: 'super-admin' } as const;

async function serve(pool: pg.Pool, cfg: StaffApiConfig, nowMs: number) {
  const server = createServer(
    apiHandler(
      pool,
      cfg,
      () => {},
      () => nowMs,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function brand(pool: pg.Pool, brandId: string, at: number) {
  await createAccount(
    pool,
    {
      brandId,
      kind: 'brand',
      details: { name: brandId, agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'first call',
    },
    at,
  );
}

let adSeq = 0;
async function approvedAd(pool: pg.Pool, brandId: string) {
  adSeq += 1;
  const adId = `AD-${adSeq.toString(16).toUpperCase().padStart(10, '0')}`;
  await pool.query(
    `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
     VALUES ($1, $2, $3, $4, 1000, 'png', '[]', 'pass', 'test', now())`,
    [adId, brandId, `Ad ${adSeq}`, adSeq.toString(16).padStart(64, '0')],
  );
  await pool.query(
    `INSERT INTO ad_reviews (ad_id, decision, checklist, reviewed_by, reviewed_at)
     VALUES ($1, 'approved', '{}', 'reviewer', now())`,
    [adId],
  );
  return adId;
}

describe('the POC page for staff, and for brands (P7.8)', () => {
  const NOW = ist('2027-07-20T11:00:00') * 1000;
  const payments = fakePayments({ clock: () => NOW / 1000 });
  const messages = fakeMessages();
  const CFG: StaffApiConfig = {
    messages,
    secretKey: randomBytes(32),
    origins: [ADMIN],
    brandOrigins: [PORTAL],
    secureCookies: true,
    proxyHops: 0,
    payments,
    maps: {
      streetAt: () => Promise.resolve('Hitech City Main Road'),
    } as unknown as NonNullable<StaffApiConfig['maps']>,
  };
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let server: Server;
  let url = '';
  const member = members(() => db.pool, NOW);
  const ads: Record<string, string[]> = {};

  beforeAll(async () => {
    db = await freshDatabase();
    ({ server, url } = await serve(db.pool, CFG, NOW));
    await savePriceBook(db.pool, PRICE_BOOK_V1, 'prateek');
    for (const b of ['alpha', 'beta']) {
      await brand(db.pool, b, NOW / 1000 - 86_400);
      ads[b] = [await approvedAd(db.pool, b), await approvedAd(db.pool, b)];
    }
    await setBusinessMode(db.pool, 'poc', SUPER, 'POC scheduled', NOW / 1000 - 3600);
    for (const [b, phone] of [
      ['alpha', '+919800000001'],
      ['beta', '+919800000002'],
    ] as const)
      await setPortalMember(
        db.pool,
        { brandId: b, address: phone, role: 'owner', active: true, reason: 'owner', by: 'Sana' },
        NOW / 1000 - 3600,
      );
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await db.drop();
  });

  const call = async (cookie: string, path: string, body?: unknown, origin = ADMIN) => {
    const r = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json', origin }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  it('only Sales (and super admins) add POC brands; Finance looks; others see nothing', async () => {
    const sana = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const meena = await member('meena@recall.in', { role: 'admin', areas: ['finance'] });
    const omar = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const add = {
      brandId: 'alpha',
      firstMonth: '2027-08',
      months: 3,
      adIds: ads.alpha,
      reason: 'signed for 3 months',
    };
    expect((await call(omar, '/poc')).status).toBe(403);
    expect((await call(meena, '/poc/brands', add)).status).toBe(403);
    expect((await call(sana, '/poc/brands', add, 'https://evil.test')).status).toBe(403);
    expect((await call(sana, '/poc/brands', { ...add, months: 4 })).body).toMatchObject({
      error: 'A commitment is 1 to 3 months',
    });
    expect((await call(sana, '/poc/brands', add)).body).toEqual({
      refs: ['poc/alpha/2027-08', 'poc/alpha/2027-09', 'poc/alpha/2027-10'],
    });
    const desk = await call(meena, '/poc');
    expect(desk.status).toBe(200);
    expect(desk.body).toMatchObject({
      on: false,
      phase: { phase: 'scheduled', startsAt: pocMonthWindow('2027-08').startsAt },
      canChange: false,
      perBrand: 5,
      bikes: { fitted: 0, max: 200 },
      brands: [{ brandId: 'alpha', months: [{ state: 'to-pay' }, {}, {}] }],
    });
    expect(
      (await call(sana, '/poc/brands/ads', { brandId: 'alpha', adIds: ads.beta })).body,
    ).toEqual({
      error: `${ads.beta?.[0] ?? ''} is not one of this brand's ads`,
    });
    // A payment link from staff, and the provider asked.
    const link = await call(sana, '/poc/pay', { ref: 'poc/alpha/2027-09' });
    expect(link.body).toMatchObject({ amountPaise: 29_500_000 });
    expect((await call(sana, '/poc/check', { ref: 'poc/alpha/2027-09' })).body).toEqual({
      outcome: 'waiting',
    });
    expect((await call(sana, '/poc/pay', { ref: 'BK-1' })).status).toBe(400);
  });

  it('a POC brand sees and pays its own months; another business gets a 404', async () => {
    /** Signs in with a WhatsApp code, as on the portal. */
    const session = async (address: string) => {
      const code = await fetch(`${url}/portal/code`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PORTAL },
        body: JSON.stringify({ address, channel: 'whatsapp' }),
      });
      expect(code.status).toBe(200);
      const m = messages.sent.at(-1);
      const r = await fetch(`${url}/portal/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PORTAL },
        body: JSON.stringify({
          address,
          code: m?.channel === 'whatsapp' ? (m.params[0] ?? '') : '',
        }),
      });
      expect(r.status).toBe(200);
      return r.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    };
    const a = await session('+919800000001');
    const b = await session('+919800000002');
    const me = await call(a, '/portal/me');
    expect(me.body).toMatchObject({ accounts: [{ brandId: 'alpha', poc: true }] });
    const page = await call(a, '/portal/poc?brand=alpha');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      month: '2027-08',
      months: [
        { month: '2027-08', state: 'to-pay', totalPaise: 29_500_000 },
        { month: '2027-09', state: 'link-sent' },
        { month: '2027-10', state: 'to-pay' },
      ],
      report: { plays: 0, people: { approximate: true } },
    });
    expect((await call(b, '/portal/poc?brand=beta')).status).toBe(404);
    expect((await call(b, '/portal/poc?brand=alpha')).status).toBe(404);
    expect((await call(b, '/portal/poc/pay?brand=alpha&month=2027-08', {}, PORTAL)).status).toBe(
      404,
    );
    // The plain POC rules must be agreed (one tick) before paying, at the version shown.
    expect(page.body).toMatchObject({ termsVersion: 1 });
    expect((page.body.terms as unknown[]).length).toBe(4);
    expect(
      (await call(a, '/portal/poc/pay?brand=alpha&month=2027-08', {}, PORTAL)).body,
    ).toMatchObject({ why: 'not-agreed' });
    expect(
      (
        await call(
          a,
          '/portal/poc/pay?brand=alpha&month=2027-08',
          { agree: true, termsVersion: 99 },
          PORTAL,
        )
      ).body,
    ).toMatchObject({ why: 'terms-changed' });
    const agreed = { agree: true, termsVersion: 1 };
    const pay = await call(a, '/portal/poc/pay?brand=alpha&month=2027-08', agreed, PORTAL);
    const terms = await db.pool.query<{ terms_version: number; accepted_by: string }>(
      "SELECT terms_version, accepted_by FROM poc_terms WHERE ref = 'poc/alpha/2027-08'",
    );
    expect(terms.rows).toEqual([{ terms_version: 1, accepted_by: 'portal:+919800000001' }]);
    expect(pay.body).toMatchObject({ amountPaise: 29_500_000 });
    // The brand pays; the provider's signed message records it.
    const m = payments.pay(String(pay.body.linkId));
    const hook = await fetch(`${url}/payments/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment-signature': m.signature },
      body: m.body,
    });
    expect(((await hook.json()) as { outcome: string }).outcome).toBe('paid');
    const after = await call(a, '/portal/poc?brand=alpha');
    expect((after.body.months as { state: string }[]).map((x) => x.state)).toEqual([
      'paid',
      'link-sent',
      'to-pay',
    ]);
    expect(
      (await call(a, '/portal/poc/pay?brand=alpha&month=2027-08', agreed, PORTAL)).status,
    ).toBe(409);
    // Its invoice is on its Invoices page.
    const inv = await call(a, '/portal/invoices?brand=alpha');
    expect(inv.body).toMatchObject({
      documents: [{ bookingId: 'poc/alpha/2027-08', pocMonth: '2027-08' }],
    });
  });
});

describe('switching back from the POC over HTTP (Prateek, 28 Oct 2026)', () => {
  const NOW = ist('2027-09-15T12:00:00') * 1000;
  const CFG: StaffApiConfig = {
    secretKey: randomBytes(32),
    origins: [ADMIN],
    secureCookies: true,
    proxyHops: 0,
  };
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let server: Server;
  let url = '';
  const member = members(() => db.pool, NOW);
  beforeAll(async () => {
    db = await freshDatabase();
    ({ server, url } = await serve(db.pool, CFG, NOW));
    await setBusinessMode(db.pool, 'poc', SUPER, 'POC scheduled', ist('2027-07-15T11:00:00'));
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await db.drop();
  });

  it('mid-month 2: alerts show where it stands; ending early needs early: true', async () => {
    const boss = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const sales = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const get = async (cookie: string, path: string) =>
      (await (await fetch(`${url}${path}`, { headers: { cookie } })).json()) as Record<
        string,
        unknown
      >;
    expect(await get(boss, '/staff/me')).toMatchObject({ alerts: [] });
    expect(await get(sales, '/staff/me')).toMatchObject({ alerts: [] });
    expect((await get(boss, '/settings')).business).toMatchObject({
      mode: 'poc',
      poc: { phase: 'running', plannedEnd: ist('2027-11-01T08:00:00') },
      pocMonths: 3,
    });
    const post = async (body: unknown) => {
      const r = await fetch(`${url}/settings/business`, {
        method: 'POST',
        headers: { cookie: boss, origin: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect(await post({ mode: 'regular', reason: 'stopping the POC' })).toEqual({
      status: 409,
      body: {
        error: 'This ends the POC 47 days early: confirm to go ahead',
        why: 'poc-early',
        n: 47,
      },
    });
    expect(await post({ mode: 'regular', reason: 'stopping the POC', early: true })).toEqual({
      status: 200,
      body: { mode: 'regular', from: ist('2027-09-15T08:00:00') },
    });
    expect((await get(boss, '/settings')).business).toMatchObject({
      mode: 'regular',
      canSwitch: false,
      poc: { phase: 'ended' },
    });
    expect((await post({ mode: 'poc', reason: 'POC again please' })).status).toBe(400);
  });
});

describe('cancelling a scheduled POC over HTTP (Prateek, 29 Oct 2026)', () => {
  const NOW = ist('2027-07-20T11:00:00') * 1000;
  const CFG: StaffApiConfig = {
    secretKey: randomBytes(32),
    origins: [ADMIN],
    secureCookies: true,
    proxyHops: 0,
  };
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let server: Server;
  let url = '';
  const member = members(() => db.pool, NOW);
  beforeAll(async () => {
    db = await freshDatabase();
    ({ server, url } = await serve(db.pool, CFG, NOW));
    await setBusinessMode(db.pool, 'poc', SUPER, 'POC scheduled', ist('2027-07-15T11:00:00'));
  }, 120_000);
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await db.drop();
  });

  it('only a super admin, with why, before it starts; then it can be switched on again', async () => {
    const boss = await member('prateek@recall.in', { role: 'super-admin', areas: [] });
    const sales = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const post = async (cookie: string, path: string, body: unknown) => {
      const r = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    expect((await post(sales, '/settings/business/cancel', { reason: 'not ready' })).status).toBe(
      403,
    );
    expect((await post(boss, '/settings/business/cancel', { reason: 'no' })).status).toBe(400);
    expect(await post(boss, '/settings/business/cancel', { reason: 'brands not ready' })).toEqual({
      status: 200,
      body: { cancelled: ist('2027-08-01T08:00:00'), owedBack: [] },
    });
    const settings = (await (
      await fetch(`${url}/settings`, { headers: { cookie: boss } })
    ).json()) as { business: Record<string, unknown> };
    expect(settings.business).toMatchObject({
      mode: 'regular',
      next: null,
      poc: { phase: 'none' },
    });
    expect((await post(boss, '/settings/business/cancel', { reason: 'again please' })).status).toBe(
      400,
    );
    expect(
      (await post(boss, '/settings/business', { mode: 'poc', reason: 'POC on again' })).body,
    ).toEqual({ mode: 'poc', from: ist('2027-08-01T08:00:00') });
  });
});
