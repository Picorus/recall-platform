// P5.1: the brand portal's sign-in routes: a code by WhatsApp, SMS or email, a session cookie
// scripts cannot read, who is signed in and what they may act for, sign-out; changes only from the
// portal's origins; a staff cookie opens nothing here and a portal cookie opens no staff route;
// Sales gives and removes portal access on a brand's page.
import { freshDatabase } from '@recall/db/test-db';
import { fakeGst, fakeMessages } from '@recall/adapters';
import { createAccount, saveAreaVersion, savePriceBook } from '@recall/db';
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
const NOW = Date.UTC(2027, 7, 23, 4, 30); // milliseconds
const messages = fakeMessages();
const PORTAL = 'https://book.recall.test';
const ADMIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ADMIN],
  brandOrigins: [PORTAL],
  secureCookies: true,
  proxyHops: 0,
  messages,
  gst: fakeGst(),
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
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  for (const x of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...x, draft: false }, 'system');
  await createAccount(
    pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'first call',
    },
    NOW / 1000 - 86_400,
  );
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

const call = async (
  path: string,
  body?: unknown,
  headers: Record<string, string> = { origin: PORTAL },
) => {
  const r = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    cookie: r.headers.getSetCookie()[0] ?? '',
    body: (await r.json()) as Record<string, unknown>,
  };
};
const lastCode = () => {
  const m = messages.sent.at(-1);
  return m?.channel === 'whatsapp'
    ? (m.params[0] ?? '')
    : m?.channel === 'sms'
      ? m.text.slice(0, 6)
      : (m?.subject.slice(0, 6) ?? '');
};
const signIn = async (address: string, channel: string) => {
  expect((await call('/portal/code', { address, channel })).status).toBe(200);
  const r = await call('/portal/sign-in', { address, code: lastCode() });
  expect(r.status).toBe(200);
  return { ...r, session: r.cookie.split(';')[0] ?? '' };
};

describe('brand portal sign-in routes (P5.1)', () => {
  it('a number signs in with a WhatsApp code; the cookie is HttpOnly and Strict; sign-out ends it', async () => {
    const asked = await call('/portal/code', { address: '98480 11111', channel: 'whatsapp' });
    expect(asked).toMatchObject({
      status: 200,
      body: { address: '+919848011111', shown: '+91 98480 11111' },
    });
    expect(messages.sent.at(-1)).toMatchObject({ channel: 'whatsapp', to: '+919848011111' });
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    expect(await call('/portal/sign-in', { address: '+919848011111', code: wrong })).toMatchObject({
      status: 400,
      body: { why: 'wrong-code', n: 4 },
    });
    const s = await call('/portal/sign-in', { address: '9848011111', code: lastCode() });
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ address: '+919848011111', shown: '+91 98480 11111', accounts: [] });
    expect(s.cookie).toMatch(
      /^__Host-recall_brand=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000; Secure$/,
    );
    const cookie = s.cookie.split(';')[0] ?? '';
    expect(await call('/portal/me', undefined, { cookie })).toMatchObject({
      status: 200,
      body: { shown: '+91 98480 11111', accounts: [] },
    });
    // A portal cookie opens no staff route; a staff route is not reached through /portal.
    expect((await call('/brands', undefined, { cookie })).status).toBe(401);
    expect((await call('/staff/me', undefined, { cookie })).status).toBe(401);
    const out = await call('/portal/sign-out', {}, { origin: PORTAL, cookie });
    expect(out.status).toBe(200);
    expect(out.cookie).toContain('Max-Age=0');
    expect((await call('/portal/me', undefined, { cookie })).status).toBe(401);
  });

  it('an email gets its code by email; bad input and other sites refused', async () => {
    expect(
      (await call('/portal/code', { address: 'Media@Adwise.in', channel: 'whatsapp' })).status,
    ).toBe(400);
    expect(
      (await call('/portal/code', { address: '+919848011111', channel: 'email' })).status,
    ).toBe(400);
    expect(await call('/portal/code', { address: 'not a number', channel: 'sms' })).toMatchObject({
      status: 400,
      body: { why: 'bad-address' },
    });
    // Not from the portal: refused before anything is sent.
    const before = messages.sent.length;
    for (const headers of [{}, { origin: ADMIN }, { origin: 'https://evil.test' }])
      expect(
        (await call('/portal/code', { address: 'media@adwise.in', channel: 'email' }, headers))
          .status,
      ).toBe(403);
    expect(messages.sent.length).toBe(before);
    const s = await signIn('Media@Adwise.in', 'email');
    expect(s.body).toMatchObject({ address: 'media@adwise.in', shown: 'media@adwise.in' });
    expect(messages.sent.at(-1)).toMatchObject({ channel: 'email', to: 'media@adwise.in' });
    expect((await call('/portal/nope', undefined, { cookie: s.session })).status).toBe(404);
    expect((await call('/portal/me')).status).toBe(401);
  });

  it('too many codes for a number: 429 with how long to wait', async () => {
    for (let i = 0; i < 3; i++)
      await call('/portal/code', { address: '+919848044444', channel: 'sms' });
    expect(await call('/portal/code', { address: '+919848044444', channel: 'sms' })).toMatchObject({
      status: 429,
      body: { why: 'too-many-number', n: 15 },
    });
  });

  it('Sales gives portal access on the brand page; the person sees the brand at once; removed, gone', async () => {
    const sales = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const support = await member('sam@recall.in', { role: 'admin', areas: ['support'] });
    const give = {
      address: '98480 55555',
      role: 'owner',
      active: true,
      reason: 'owner of Chai Co',
    };
    expect(
      (await call('/brands/chai-co/portal', give, { origin: ADMIN, cookie: support })).status,
    ).toBe(403);
    // Only from the admin site.
    expect(
      (await call('/brands/chai-co/portal', give, { origin: PORTAL, cookie: sales })).status,
    ).toBe(403);
    expect(
      await call('/brands/chai-co/portal', give, { origin: ADMIN, cookie: sales }),
    ).toMatchObject({ status: 200, body: { address: '+919848055555', version: 1 } });
    expect(
      (
        await call(
          '/brands/chai-co/portal',
          { ...give, role: 'boss' },
          { origin: ADMIN, cookie: sales },
        )
      ).status,
    ).toBe(400);
    const page = await call('/brands/chai-co', undefined, { cookie: support });
    expect(page.body.portal).toMatchObject([
      {
        address: '+919848055555',
        role: 'owner',
        active: true,
        setBy: expect.stringMatching(/^sana \(/),
      },
    ]);
    const s = await signIn('+919848055555', 'whatsapp');
    expect(s.body.accounts).toEqual([
      { brandId: 'chai-co', name: 'Chai Co', kind: 'brand', role: 'owner' },
    ]);
    await call(
      '/brands/chai-co/portal',
      { ...give, active: false, reason: 'sold the shop' },
      { origin: ADMIN, cookie: sales },
    );
    expect((await call('/portal/me', undefined, { cookie: s.session })).body.accounts).toEqual([]);
  });

  it('a new person sets up their business from its GST number and owns it (P5.2)', async () => {
    const s = await signIn('+919848077777', 'whatsapp');
    const c = { origin: PORTAL, cookie: s.session };
    const form = await call('/portal/business-form', undefined, { cookie: s.session });
    expect(form.body.types).toContainEqual({ key: 'food', label: 'Food and drink' });
    expect(form.body.states).toContainEqual({ code: '36', name: 'Telangana' });
    expect(await call('/portal/gst', { gstin: '36 aapfu0939f1zw' }, c)).toMatchObject({
      status: 200,
      body: { status: 'found', stateName: 'Telangana' },
    });
    expect(await call('/portal/gst', { gstin: '36AAPFU0939F1ZX' }, c)).toMatchObject({
      status: 400,
      body: { why: 'bad-gstin' },
    });
    const made = await call(
      '/portal/business',
      {
        gstin: '36AAPFU0939F1ZW',
        name: 'Irani Chai',
        kind: 'brand',
        businessType: 'food',
        invoiceEmail: 'Accounts@IraniChai.in',
        phone: '98480 77777',
      },
      c,
    );
    expect(made).toMatchObject({ status: 200, body: { brandId: 'irani-chai' } });
    expect((await call('/portal/me', undefined, { cookie: s.session })).body.accounts).toEqual([
      { brandId: 'irani-chai', name: 'Irani Chai', kind: 'brand', role: 'owner' },
    ]);
    expect(
      await call('/portal/business?brand=irani-chai', undefined, { cookie: s.session }),
    ).toMatchObject({
      status: 200,
      body: {
        gstin: '36AAPFU0939F1ZW',
        invoiceEmail: 'accounts@iranichai.in',
        businessType: 'food',
      },
    });
    // Another business's page: the same answer as one that does not exist.
    expect(
      (await call('/portal/business?brand=chai-co', undefined, { cookie: s.session })).status,
    ).toBe(404);
    // The same GST number from someone else: looked up as usual (nothing says it is with us).
    const t = await signIn('+919848088888', 'sms');
    expect(
      await call(
        '/portal/gst',
        { gstin: '36AAPFU0939F1ZW' },
        { origin: PORTAL, cookie: t.session },
      ),
    ).toMatchObject({ status: 200, body: { status: 'found' } });
    expect(
      (await call('/portal/business', { name: 'x' }, { origin: PORTAL, cookie: t.session })).status,
    ).toBe(400);
  });

  it('book: the form, a live price, the booking saved, then in its campaigns; book again (P5.3–P5.4)', async () => {
    // The owner of Irani Chai from the test above.
    const s = await signIn('+919848077777', 'whatsapp');
    const c = { origin: PORTAL, cookie: s.session };
    const form = await call('/portal/book-form?brand=irani-chai', undefined, { cookie: s.session });
    expect(form.status).toBe(200);
    expect(form.body.form).toMatchObject({
      earliestStart: '2027-09-08',
      minBikes: 5,
      maxBikes: 100,
    });
    expect(form.body.plan).toBeNull();
    const plan = {
      areaIds: ['hyd-madhapur'],
      hours: [19, 20],
      weekdays: [5, 6],
      startDate: '2027-09-08',
      weeks: 2,
      bikes: 20,
      repeatMonths: 1,
    };
    expect(await call('/portal/quote?brand=irani-chai', { plan }, c)).toMatchObject({
      status: 200,
      body: { price: { bikeHours: 160, totalPaise: 5_664_000 }, problems: [] },
    });
    expect(
      (await call('/portal/quote?brand=irani-chai', { plan: { ...plan, hours: 'x' } }, c)).status,
    ).toBe(400);
    const made = await call('/portal/bookings?brand=irani-chai', { plan }, c);
    expect(made.status).toBe(200);
    const id = String(made.body.bookingId);
    const list = await call('/portal/campaigns?brand=irani-chai', undefined, { cookie: s.session });
    expect(list.body.campaigns).toMatchObject([{ bookingId: id, stage: 'to-pay', bikeHours: 160 }]);
    const again = await call(`/portal/book-form?brand=irani-chai&again=${id}`, undefined, {
      cookie: s.session,
    });
    expect(again.body.plan).toEqual(plan);
    // Not theirs: the same as not there.
    for (const path of ['/portal/campaigns?brand=chai-co', '/portal/book-form?brand=chai-co'])
      expect((await call(path, undefined, { cookie: s.session })).status).toBe(404);
    expect((await call('/portal/bookings?brand=chai-co', { plan }, c)).status).toBe(404);
  });
});
