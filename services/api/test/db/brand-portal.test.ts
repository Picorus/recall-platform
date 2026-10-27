// P5.1: the brand portal's sign-in routes: a code by WhatsApp, SMS or email, a session cookie
// scripts cannot read, who is signed in and what they may act for, sign-out; changes only from the
// portal's origins; a staff cookie opens nothing here and a portal cookie opens no staff route;
// Sales gives and removes portal access on a brand's page.
import { freshDatabase } from '@recall/db/test-db';
import { fakeFileStore, fakeGst, fakeMessages, fakePayments } from '@recall/adapters';
import { readFileSync } from 'node:fs';
import { createAccount, saveAreaVersion, savePriceBook } from '@recall/db';
import { launchAreas, PRICE_BOOK_V1, type CampaignReport } from '@recall/domain';
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
  files: fakeFileStore({ baseUrl: 'http://files', secret: 's' }),
  payments: fakePayments(),
};
const member = members(() => pool, NOW);
/** The owner of Irani Chai, signed in once (a number may ask for only a few codes). */
let owner = { session: '' };

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
    owner = s;
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
    const s = owner;
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

  it('your ads: upload (checked), see the file, choose 2 to 5 for a campaign; only its own (P5.5)', async () => {
    const s = owner;
    const fixture = (n: string) =>
      readFileSync(new URL(`../../../../packages/domain/test/fixtures/ads/${n}`, import.meta.url));
    const up = async (file: string, name: string, cookie = s.session, brand = 'irani-chai') => {
      const body = fixture(file);
      const r = await fetch(
        `${url}/portal/ads/upload?brand=${brand}&name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: { origin: PORTAL, cookie, 'content-type': 'application/octet-stream' },
          body,
        },
      );
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const a = await up('ad-1280x640.png', 'Chai pic');
    const b = await up('ad-15s-1280x640.mp4', 'Chai video');
    const bad = await up('ad-1280x720.png', 'Wrong shape');
    expect(a).toMatchObject({
      status: 200,
      body: { ad: { name: 'Chai pic', outcome: 'pass', review: null } },
    });
    expect(b.status).toBe(200);
    expect(bad.body.ad).toMatchObject({ outcome: 'fail' });
    const ids = [a, b].map((x) => String((x.body.ad as { adId: string }).adId));
    // The file itself, for its own brand only.
    const f = await fetch(`${url}/portal/ads/file?brand=irani-chai&ad=${ids[0]}`, {
      headers: { cookie: s.session },
    });
    expect(f.status).toBe(200);
    expect(f.headers.get('content-type')).toBe('image/png');
    expect(
      (await call('/portal/ads?brand=irani-chai', undefined, { cookie: s.session })).body.ads,
    ).toHaveLength(3);
    // Its campaign from the test above.
    const list = await call('/portal/campaigns?brand=irani-chai', undefined, { cookie: s.session });
    const booking = String((list.body.campaigns as { bookingId: string }[])[0]?.bookingId);
    const c = { origin: PORTAL, cookie: s.session };
    const badId = String((bad.body.ad as { adId: string }).adId);
    expect(
      await call(
        `/portal/booking-ads?brand=irani-chai&booking=${booking}`,
        { adIds: [ids[0], badId] },
        c,
      ),
    ).toMatchObject({ status: 400, body: { error: 'Wrong shape failed the automatic checks' } });
    expect(
      (await call(`/portal/booking-ads?brand=irani-chai&booking=${booking}`, { adIds: ids }, c))
        .status,
    ).toBe(200);
    const chosen = await call(
      `/portal/booking-ads?brand=irani-chai&booking=${booking}`,
      undefined,
      { cookie: s.session },
    );
    expect((chosen.body.ads as { adId: string }[]).map((x) => x.adId)).toEqual(ids);
    // Someone else: not their ads, files or campaigns.
    const t = await signIn('+919848088888', 'sms');
    expect(
      (
        await fetch(`${url}/portal/ads/file?brand=irani-chai&ad=${ids[0]}`, {
          headers: { cookie: t.session },
        })
      ).status,
    ).toBe(404);
    expect((await up('ad-1280x640.png', 'x', t.session)).status).toBe(404);
    expect(
      (
        await call(`/portal/booking-ads?brand=irani-chai&booking=${booking}`, undefined, {
          cookie: t.session,
        })
      ).status,
    ).toBe(404);
  });

  it('a ready-made ad: logo, a preview, then kept as an ad that passes the checks (P5.5)', async () => {
    const s = owner;
    const logo = readFileSync(
      new URL('../../../../packages/domain/test/fixtures/ads/ad-1280x640.png', import.meta.url),
    );
    const l = await fetch(`${url}/portal/logo?brand=irani-chai`, {
      method: 'POST',
      headers: { origin: PORTAL, cookie: s.session, 'content-type': 'application/octet-stream' },
      body: logo,
    });
    expect(await l.json()).toEqual({ logo: { width: 1280, height: 640 } });
    // Too many pixels (it would hold up the server to draw) or WebP (it cannot be drawn): refused.
    const { Resvg } = await import('@resvg/resvg-js');
    const huge = new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="20"><rect width="2400" height="20" fill="#000"/></svg>',
    )
      .render()
      .asPng();
    for (const [body, error] of [
      [huge, 'A logo is at most 2000 × 2000 pixels: make it smaller'],
      [
        readFileSync(
          new URL(
            '../../../../packages/domain/test/fixtures/ads/ad-1280x640.webp',
            import.meta.url,
          ),
        ),
        'A logo is a PNG or JPEG picture',
      ],
    ] as const) {
      const r = await fetch(`${url}/portal/logo?brand=irani-chai`, {
        method: 'POST',
        headers: { origin: PORTAL, cookie: s.session, 'content-type': 'application/octet-stream' },
        body,
      });
      expect({ status: r.status, error: ((await r.json()) as { error: string }).error }).toEqual({
        status: 400,
        error,
      });
    }
    const template = {
      headline: 'Irani Chai',
      offer: 'Two chai for ₹30',
      code: 'chai30',
      qr: 'https://iranichai.in',
      colour: '#C9F24B',
      theme: 'band',
      layout: 1,
    };
    const p = await fetch(`${url}/portal/ads/template-preview?brand=irani-chai`, {
      method: 'POST',
      headers: { origin: PORTAL, cookie: s.session, 'content-type': 'application/json' },
      body: JSON.stringify({ template }),
    });
    expect(p.status).toBe(200);
    expect(p.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await p.arrayBuffer()).subarray(1, 4)).toEqual(
      new Uint8Array([80, 78, 71]),
    );
    const c = { origin: PORTAL, cookie: s.session };
    expect(
      await call(
        '/portal/ads/template-preview?brand=irani-chai',
        { template: { ...template, headline: 'x'.repeat(31) } },
        c,
      ),
    ).toMatchObject({ status: 400, body: { why: 'bad-template' } });
    const made = await call('/portal/ads/template?brand=irani-chai', { template }, c);
    expect(made).toMatchObject({
      status: 200,
      body: { ad: { name: 'Irani Chai', kind: 'png', width: 1280, height: 640, outcome: 'pass' } },
    });
  });

  it('review and pay: line by line, the rules agreed, a payment link; only its own (P5.6)', async () => {
    const s = owner;
    const c = { origin: PORTAL, cookie: s.session };
    const list = await call('/portal/campaigns?brand=irani-chai', undefined, { cookie: s.session });
    const booking = String((list.body.campaigns as { bookingId: string }[])[0]?.bookingId);
    const r = await call(`/portal/review?brand=irani-chai&booking=${booking}`, undefined, {
      cookie: s.session,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      state: 'draft',
      totalPaise: 5_664_000,
      gst: { cgst: 432_000, sgst: 432_000, igst: 0 },
    });
    expect((r.body.terms as unknown[]).length).toBe(5);
    expect(
      await call(
        `/portal/pay?brand=irani-chai&booking=${booking}`,
        { agree: false, termsVersion: r.body.termsVersion },
        c,
      ),
    ).toMatchObject({ status: 400, body: { why: 'not-agreed' } });
    const pay = await call(
      `/portal/pay?brand=irani-chai&booking=${booking}`,
      { agree: true, termsVersion: r.body.termsVersion },
      c,
    );
    expect(pay).toMatchObject({ status: 200, body: { amountPaise: 5_664_000 } });
    expect(String(pay.body.url)).toMatch(/^https:\/\//);
    const t = await signIn('+919848088888', 'sms');
    expect(
      (
        await call(`/portal/review?brand=irani-chai&booking=${booking}`, undefined, {
          cookie: t.session,
        })
      ).status,
    ).toBe(404);
  });

  it('the final report: its page and PDF for its own people only; listed as ready (P5.7)', async () => {
    const s = owner;
    const list = await call('/portal/campaigns?brand=irani-chai', undefined, { cookie: s.session });
    const booking = String((list.body.campaigns as { bookingId: string }[])[0]?.bookingId);
    expect((list.body.campaigns as { report: boolean }[])[0]?.report).toBe(false);
    expect(
      await call(`/portal/report?booking=${booking}`, undefined, { cookie: s.session }),
    ).toMatchObject({ status: 404, body: { why: 'no-report' } });
    const report: CampaignReport = {
      bookingId: booking,
      brandId: 'irani-chai',
      from: NOW / 1000 - 7200,
      until: NOW / 1000,
      builtAt: NOW / 1000,
      lines: [],
      promised: 6_000,
      delivered: 5_400,
      deliveredBp: 9_000,
      missing: 600,
      bikes: 28,
      makeUps: { opened: 0, plays: 0 },
      refund: undefined,
      heatMap: [],
      streets: [],
      people: { low: 20_000, high: 28_000, approximate: true, text: '20,000–28,000 (approximate)' },
    };
    await pool.query(
      `INSERT INTO campaign_reports (booking_id, built_at, report) VALUES ($1, to_timestamp($2), $3)`,
      [booking, report.builtAt, JSON.stringify(report)],
    );
    const again = await call('/portal/campaigns?brand=irani-chai', undefined, {
      cookie: s.session,
    });
    expect((again.body.campaigns as { report: boolean }[])[0]?.report).toBe(true);
    // No brand in the link (as the "Done" message sends it): the report says whose it is.
    const r = await call(`/portal/report?booking=${booking}`, undefined, { cookie: s.session });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bookingId: booking, account: { brandId: 'irani-chai' } });
    expect(String(r.body.html)).toContain('<!doctype html>');
    expect((r.body.summary as string[]).join(' ')).toMatch(/5,400 of 6,000 plays delivered/);
    const pdf = await fetch(`${url}/portal/report/pdf?booking=${booking}`, {
      headers: { cookie: s.session },
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toContain(`RECALL-report-${booking}.pdf`);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    // Someone else's, not there, odd ids, signed out: nothing.
    const t = await signIn('+919848066666', 'sms');
    for (const [path, cookie] of [
      [`/portal/report?booking=${booking}`, t.session],
      [`/portal/report/pdf?booking=${booking}`, t.session],
      ['/portal/report?booking=BK-NONE', s.session],
      ['/portal/report?booking=../x', s.session],
    ] as const)
      expect((await fetch(`${url}${path}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${url}/portal/report?booking=${booking}`)).status).toBe(401);
  });
});
