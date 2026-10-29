// The brand portal in a real browser against the real API and a real database (P5.1): a new
// business signs in with a WhatsApp code and is welcomed; a person RECALL's team gave access signs
// in by email and sees their brand; wrong codes are told; sign-out ends it.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { fakeFileStore, fakeGst, fakeMessages, fakePayments } from '@recall/adapters';
import {
  launchAreas,
  playBytes,
  PRICE_BOOK_V1,
  type CampaignReport,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { apiHandler } from '@recall/api';
import {
  addPocBrand,
  addScreenKey,
  applyLinkStatus,
  sendPocForPayment,
  setBusinessMode,
  storeUpload,
  createAccount,
  createBooking,
  moveBooking,
  saveAreaVersion,
  savePriceBook,
  saveSetting,
  setPortalMember,
} from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

const PORT = 3102;
const SITE = `http://localhost:${PORT}`;
const messages = fakeMessages();
const payments = fakePayments();
const SHOTS = process.env.SCREENSHOT_DIR;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let api: Server;
let next: ChildProcess;
let browser: Browser;

/** The code in the last message sent to a number or email. */
const lastCode = (to: string) => {
  const m = [...messages.sent].reverse().find((x) => x.to === to);
  return m?.channel === 'whatsapp'
    ? (m.params[0] ?? '')
    : m?.channel === 'sms'
      ? m.text.slice(0, 6)
      : (m?.subject.slice(0, 6) ?? '');
};

beforeAll(async () => {
  db = await freshDatabase();
  api = createServer(
    apiHandler(
      db.pool,
      {
        secretKey: randomBytes(32),
        origins: ['http://localhost:3101'],
        brandOrigins: [SITE],
        secureCookies: true,
        proxyHops: 1,
        messages,
        gst: fakeGst(),
        payments,
        files: fakeFileStore({ baseUrl: `${SITE}/api/files`, secret: 'e2e' }),
      },
      (l) => console.error(l),
    ),
  );
  await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  if (
    await fetch(SITE).then(
      () => true,
      () => false,
    )
  )
    throw new Error(`port ${PORT} is in use`);
  next = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    detached: true,
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, API_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    if (
      await fetch(`${SITE}/sign-in`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  browser = await chromium.launch();
  const now = Math.floor(Date.now() / 1000);
  // In force (with the areas) from long ago: a campaign that ran last week is booked on them (P5.7).
  await savePriceBook(
    db.pool,
    { ...PRICE_BOOK_V1, validFrom: '2020-01-01T00:00:00.000Z' },
    'prateek',
  );
  await saveSetting(
    db.pool,
    'freeWeek',
    { on: true },
    { id: 'prateek', role: 'super-admin' },
    'offer it',
    0,
  );
  await createAccount(
    db.pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'first call',
    },
    now - 60,
  );
  for (const a of launchAreas('2020-01-01T00:00:00.000Z'))
    await saveAreaVersion(db.pool, { ...a, draft: false }, 'system');
  const day = new Date((now + 30 * 86_400) * 1000).toISOString().slice(0, 10);
  await createBooking(
    db.pool,
    {
      bookingId: 'BK-E2E-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: day, startHour: 19, bikes: 40 },
          { areaId: 'hyd-madhapur', date: day, startHour: 20, bikes: 40 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    now - 50,
  );
  await moveBooking(
    db.pool,
    'BK-E2E-1',
    'awaiting-payment',
    { by: 'Sana', actor: 'admin' },
    now - 40,
  );
  // P5.10: an agency with one linked brand.
  await createAccount(
    db.pool,
    {
      brandId: 'adwise',
      kind: 'agency',
      details: { name: 'Adwise Media', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'agency',
    },
    now - 60,
  );
  await createAccount(
    db.pool,
    {
      brandId: 'dosa-co',
      kind: 'brand',
      details: { name: 'Dosa Co', agencyId: 'adwise', referredBy: null, active: true },
      by: 'Sana',
      reason: 'books through Adwise',
    },
    now - 60,
  );
  await setPortalMember(
    db.pool,
    {
      brandId: 'adwise',
      address: 'ops@adwise.in',
      role: 'owner',
      active: true,
      reason: 'agency lead',
      by: 'Sana',
    },
    now - 30,
  );
  // P5.7: a campaign that ran last week, with its final report built.
  const ranOn = new Date((now - 5 * 86_400) * 1000).toISOString().slice(0, 10);
  await createBooking(
    db.pool,
    {
      bookingId: 'BK-E2E-DONE',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: ranOn, startHour: 19, bikes: 40 },
          { areaId: 'hyd-madhapur', date: ranOn, startHour: 20, bikes: 40 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    now - 30 * 86_400,
  );
  const who = { by: 'Sana', actor: 'admin' } as const;
  const sys = { by: 'system', actor: 'system' } as const;
  await moveBooking(db.pool, 'BK-E2E-DONE', 'awaiting-payment', who, now - 30 * 86_400);
  await moveBooking(db.pool, 'BK-E2E-DONE', 'paid', sys, now - 29 * 86_400);
  await moveBooking(db.pool, 'BK-E2E-DONE', 'ads-approved', who, now - 20 * 86_400);
  // Its first hour starts 19:00 India time (13:30 UTC) that day, whatever time the test runs.
  const firstHour = Date.parse(`${ranOn}T13:30:00Z`) / 1000;
  await moveBooking(db.pool, 'BK-E2E-DONE', 'running', sys, firstHour);
  await moveBooking(db.pool, 'BK-E2E-DONE', 'done', sys, firstHour + 3 * 3600);
  const report: CampaignReport = {
    bookingId: 'BK-E2E-DONE',
    brandId: 'chai-co',
    from: now - 5 * 86_400,
    until: now - 5 * 86_400 + 3600,
    builtAt: now - 3 * 86_400,
    lines: [19, 20].map((hour) => ({
      lineId: `BK-E2E-DONE/hyd-madhapur/${ranOn}/${hour}`,
      areaId: 'hyd-madhapur',
      areaName: 'Madhapur',
      date: ranOn,
      startHour: hour,
      bikes: 40,
      promised: 1_500,
      delivered: hour === 19 ? 1_400 : 1_330,
      madeUp: 60,
      missing: hour === 19 ? 40 : 110,
    })),
    promised: 3_000,
    delivered: 2_850,
    deliveredBp: 9_500,
    missing: 150,
    bikes: 29,
    makeUps: { opened: 1, plays: 120 },
    refund: undefined,
    heatMap: [],
    streets: [{ name: 'Hitech City Road', plays: 900 }],
    people: { low: 9_000, high: 13_000, approximate: true, text: '9,000–13,000 (approximate)' },
  };
  await db.pool.query(
    `INSERT INTO campaign_reports (booking_id, built_at, report) VALUES ($1, to_timestamp($2), $3)`,
    [report.bookingId, report.builtAt, JSON.stringify(report)],
  );
  await setPortalMember(
    db.pool,
    {
      brandId: 'chai-co',
      address: 'media@chaico.in',
      role: 'owner',
      active: true,
      reason: 'their marketing lead',
      by: 'Sana',
    },
    now - 30,
  );
}, 120_000);

afterAll(async () => {
  await browser?.close();
  // The whole process group: npx and the Next server it started.
  if (next?.pid) process.kill(-next.pid, 'SIGTERM');
  await new Promise<void>((ok) => api.close(() => ok()));
  await db.drop();
});

it('a new business signs in with a WhatsApp code, a wrong code is told, and signs out', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Not signed in: the first page sends you to sign in.
  await page.goto(SITE);
  await page.waitForURL(`${SITE}/sign-in`);
  await page.getByLabel('Mobile number').fill('98480 11111');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByText('We sent a 6-digit code on WhatsApp to +91 98480 11111').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-sign-in-code.png` });
  const code = lastCode('+919848011111');
  await page.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Wrong code: 4 tries left').waitFor();
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Welcome to RECALL' }).waitFor();
  await page.getByText('+91 98480 11111').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-welcome.png` });
  // The session cookie is out of scripts' reach.
  expect(await page.evaluate('document.cookie')).toBe('');
  // Signed in: the sign-in page sends you in.
  await page.goto(`${SITE}/sign-in`);
  await page.waitForURL(`${SITE}/`);
  // Sign out sits in the account menu (P7.7.2), opened from the name in the top bar.
  await page.getByLabel('Your account').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${SITE}/sign-in`);
  await page.goto(SITE);
  await page.waitForURL(`${SITE}/sign-in`);
  expect(errors).toEqual([]);
  await page.close();
}, 90_000);

it('a person given access signs in by email and sees their brand', async () => {
  const page = await browser.newPage();
  await page.goto(`${SITE}/sign-in`);
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Work email').fill('Media@ChaiCo.in');
  await page.getByRole('button', { name: 'Send code by email' }).click();
  await page.getByText('by email to media@chaico.in').waitFor();
  await page.getByLabel('Code').fill(lastCode('media@chaico.in'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  // One business: its campaigns open straight away (P5.3).
  await page.getByRole('heading', { name: 'Chai Co' }).waitFor();
  const card = page.getByRole('listitem', { name: 'Campaign BK-E2E-1' });
  await card.getByText('To pay').waitFor();
  await card.getByText('80').waitFor();
  await card.getByText('Waiting for your payment', { exact: false }).waitFor();
  await card.getByRole('link', { name: 'Book again' }).waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-campaigns.png`, fullPage: true });
  // P5.9: Help (answers, a question to our team) and Team (the owner adds a colleague).
  await page.getByRole('link', { name: 'Help' }).click();
  await page.getByRole('heading', { name: 'Questions and answers' }).waitFor();
  await page.getByText('What do I pay for?').click();
  await page.getByText(/Each bike-hour plays your ads \d+ times/).waitFor();
  const ask = page.getByRole('form', { name: 'Ask us' });
  await ask.getByLabel('What it is about').fill('Start sooner');
  await ask.getByLabel('Your question').fill('Can our campaign start next week?');
  await ask.getByRole('button', { name: 'Send to our team' }).click();
  await page.getByText('Sent. Our team answers on email').waitFor();
  // P7.7.7: earlier questions sit behind one press.
  const asked = page.getByRole('region', { name: 'Your questions' });
  await asked.getByText(/1 question, latest/).waitFor();
  await asked.locator('summary').click();
  await asked.getByText('Start sooner').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-help.png`, fullPage: true });
  await page.getByRole('link', { name: 'Team' }).click();
  const add = page.getByRole('form', { name: 'Add a person' });
  await add.getByLabel('Mobile number or work email').fill('ravi@chaico.in');
  await add.getByRole('button', { name: 'Add' }).click();
  await page.getByText('ravi@chaico.in can now sign in').waitFor();
  await page.getByRole('list', { name: 'People' }).getByText('ravi@chaico.in').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-team.png`, fullPage: true });
  await page.goto(`${SITE}/campaigns?brand=chai-co`);
  await page.getByRole('heading', { name: 'Chai Co' }).waitFor();
  // The site passes only the portal's routes: a staff route is not reachable through it.
  const staff = await page.evaluate(async () => (await fetch('/api/staff/me')).status);
  expect(staff).toBe(404);
  await page.close();
}, 60_000);

it('the report link from the "Done" message: sign in, then the report; PDF and book again (P5.7)', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Signed out (a fresh browser): to sign-in, then back to the report.
  await page.goto(`${SITE}/campaigns/BK-E2E-DONE/report`);
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Work email').fill('media@chaico.in');
  await page.getByRole('button', { name: 'Send code by email' }).click();
  await page.getByText('by email to media@chaico.in').waitFor();
  await page.getByLabel('Code').fill(lastCode('media@chaico.in'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Campaign report' }).waitFor();
  expect(new URL(page.url()).pathname).toBe('/campaigns/BK-E2E-DONE/report');
  const report = page.frameLocator('iframe[title="Report BK-E2E-DONE"]');
  await report.getByText('Hitech City Road').waitFor();
  await report.getByText('9,000–13,000 (approximate)', { exact: false }).first().waitFor();
  // P7.7.7: plays delivered of promised, by day and by hour, above the report.
  await page.getByRole('meter', { name: 'Plays delivered on 80 bike-hours booked' }).waitFor();
  await page.getByText('2,850 of 3,000 promised').waitFor();
  // One day: no day-by-day chart (one bar is not a chart); its hours are.
  expect(await page.getByText('Plays, day by day').count()).toBe(0);
  await page
    .getByRole('img', { name: /^Plays by hour of the day\..*Highest 1,460 at 7pm/ })
    .waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-report.png`, fullPage: true });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('RECALL-report-BK-E2E-DONE.pdf');
  // From its campaigns too: "See the report" on the Done one.
  await page.getByRole('link', { name: 'Back to campaigns' }).click();
  await page.getByRole('tab', { name: /^Done/ }).click();
  const card = page.getByRole('listitem', { name: 'Campaign BK-E2E-DONE' });
  await card.getByRole('link', { name: 'See the report' }).click();
  await page.getByRole('link', { name: 'Book again' }).click();
  await page.getByRole('heading', { name: 'Book for Chai Co' }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

it('an agency sees its brands, books for them and reads its statement (P5.10)', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/sign-in`);
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Work email').fill('ops@adwise.in');
  await page.getByRole('button', { name: 'Send code by email' }).click();
  await page.getByText('by email to ops@adwise.in').waitFor();
  await page.getByLabel('Code').fill(lastCode('ops@adwise.in'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  const accounts = page.getByRole('region', { name: 'Your accounts' });
  await accounts.getByText('through Adwise Media').waitFor();
  await accounts.getByRole('link', { name: 'Adwise Media' }).click();
  const brands = page.getByRole('region', { name: 'Your brands' });
  await brands.getByRole('link', { name: 'Dosa Co' }).waitFor();
  await page.getByRole('link', { name: 'Statement' }).click();
  await page.getByRole('heading', { name: 'Statement' }).waitFor();
  await page.getByText('Owed to you at the end').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-statement.png`, fullPage: true });
  await page.getByRole('link', { name: 'Back' }).click();
  await page
    .getByRole('region', { name: 'Your brands' })
    .getByRole('link', { name: 'Dosa Co' })
    .click();
  await page.getByText('You book for Dosa Co through Adwise Media.').waitFor();
  await page.getByRole('link', { name: 'Book', exact: true }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

it('a new business sets itself up from its GST number, sees its free week, books and books again (P5.2–P5.4)', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Mobile number').fill('98480 22222');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByText('to +91 98480 22222').waitFor();
  await page.getByLabel('Code').fill(lastCode('+919848022222'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Set up your business' }).click();
  await page.getByLabel('GST number', { exact: true }).fill('36aapfu0939f1zw');
  await page.getByRole('button', { name: 'Find my business' }).click();
  await page.getByText('Test Business AAPFU0939F Private Limited').waitFor();
  // The trade name is offered as the business name.
  expect(await page.getByLabel('Business name').inputValue()).toBe('Test AAPFU');
  await page.getByLabel('Business name').fill('Irani Chai');
  await page.getByLabel('Kind of business').selectOption({ label: 'Food and drink' });
  await page.getByLabel('Email for invoices').fill('accounts@iranichai.in');
  expect(await page.getByLabel('Mobile for WhatsApp messages').inputValue()).toBe(
    '+91 98480 22222',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-business-new.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save my business' }).click();
  await page.getByRole('heading', { name: 'Irani Chai' }).waitFor();
  await page.getByRole('heading', { name: 'Your free week' }).waitFor();
  await page.getByText('36AAPFU0939F1ZW').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-business.png`, fullPage: true });
  // Its first page now opens its campaigns (none yet).
  await page.goto(SITE);
  await page.getByRole('heading', { name: 'Irani Chai' }).waitFor();
  await page.getByRole('heading', { name: 'No campaigns yet' }).waitFor();
  // P5.4: book from the map, the evening rush, every day for a week, 20 bikes.
  await page.getByRole('link', { name: 'Book your first campaign' }).click();
  await page.getByRole('heading', { name: 'Book for Irani Chai' }).waitFor();
  const summary = page.getByRole('complementary', { name: 'Summary' });
  await summary.getByText('Pick areas, hours and days to see the price.').waitFor();
  await page.getByRole('checkbox', { name: 'Madhapur' }).click();
  await page.getByRole('button', { name: 'Evening rush' }).click();
  // 1 area × 3 hours × 7 days × 20 bikes = 420 bike-hours at ₹300: ₹1,26,000 + 18% GST.
  await summary.getByText('420', { exact: true }).waitFor();
  await summary.getByText('₹1,48,680').waitFor();
  expect(await summary.getByRole('button', { name: 'Continue' }).isEnabled()).toBe(true);
  // Too few bikes: told, and Continue is off.
  await page.getByLabel('Bikes each hour').fill('3');
  await summary.getByText('From 5 to 100 bikes each hour').waitFor();
  expect(await summary.getByRole('button', { name: 'Continue' }).isEnabled()).toBe(false);
  await page.getByLabel('Bikes each hour').fill('20');
  await summary.getByText('₹1,48,680').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-book.png`, fullPage: true });
  await summary.getByRole('button', { name: 'Continue' }).click();
  // P5.5: next, its ads: two pictures uploaded, checked, chosen and saved.
  await page.getByRole('heading', { name: 'Your ads' }).waitFor();
  const fixture = (n: string) =>
    new URL(`../../../../packages/domain/test/fixtures/ads/${n}`, import.meta.url).pathname;
  const up = page.getByRole('form', { name: 'Upload an ad' });
  for (const [file, name] of [
    ['ad-1280x640.png', 'Chai pic'],
    ['ad-1280x640.jpg', 'Chai pic two'],
  ] as const) {
    await up.getByLabel('File').setInputFiles(fixture(file));
    await up.getByLabel('Name (for you)').fill(name);
    await up.getByRole('button', { name: 'Upload' }).click();
    await page.getByText(`${name} is uploaded.`).waitFor();
  }
  await page
    .getByRole('listitem', { name: 'Ad Chai pic two' })
    .getByText('Being checked by our team')
    .waitFor();
  await page.getByText('2 of 2 to 5 ads chosen').waitFor();
  // A ready-made one too: drawn as they type, then kept.
  const make = page.getByRole('region', { name: 'Make an ad' });
  await make.getByLabel('Headline').fill('Irani Chai');
  await make.getByLabel('Offer line').fill('Two chai for ₹30 till Sunday');
  await make.getByRole('radio', { name: 'Your colour as the background' }).click();
  await make.getByRole('img', { name: 'Your ad as it will look' }).waitFor();
  await make.getByRole('button', { name: 'Make another version' }).click();
  await make.getByRole('button', { name: 'Use this ad' }).click();
  await page.getByText('Irani Chai is made.').waitFor();
  await page.getByText('3 of 2 to 5 ads chosen').waitFor();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-ads.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save my choice' }).click();
  await page.getByText('Your choice is saved.').waitFor();
  // P5.6: review and pay: line by line, the rules ticked, to the payment page; paid there.
  await page.getByRole('link', { name: 'Next: review and pay' }).click();
  await page.getByRole('heading', { name: 'Review and pay' }).waitFor();
  const toPay = page.getByRole('complementary', { name: 'To pay' });
  await toPay.getByText('₹1,48,680', { exact: true }).waitFor();
  await toPay.getByText('CGST 9%').waitFor();
  expect(await toPay.getByRole('button', { name: 'Pay ₹1,48,680' }).isEnabled()).toBe(false);
  await page.getByLabel('I have read these five rules and agree to them').check();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-pay.png`, fullPage: true });
  await page.route('https://pay.fake.recall.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Fake payment page</h1>' }),
  );
  await toPay.getByRole('button', { name: 'Pay ₹1,48,680' }).click();
  await page.getByRole('heading', { name: 'Fake payment page' }).waitFor();
  const linkId = page.url().split('/').at(-1) ?? '';
  payments.pay(linkId);
  expect(
    await applyLinkStatus(
      db.pool,
      linkId,
      await payments.status(linkId),
      Math.floor(Date.now() / 1000),
    ),
  ).toBe('paid');
  // P5.8: its tax invoice at once, to download.
  await page.goto(`${SITE}/invoices?brand=irani-chai`);
  const invoices = page.getByRole('table', { name: /^Invoices / });
  await invoices.getByText('Tax invoice').waitFor();
  await invoices.getByText('₹1,48,680').waitFor();
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    invoices.getByRole('link', { name: /^Download RC\// }).click(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(/^RECALL-RC-\d{2}-\d{2}-\d{6}\.pdf$/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-invoices.png`, fullPage: true });
  // In its campaigns: paid and scheduled, its ads being checked; "Book again" opens the same plan.
  await page.goto(`${SITE}/campaigns?brand=irani-chai`);
  const card = page.getByRole('listitem', { name: /^Campaign BK-/ });
  await card.getByText('Scheduled').waitFor();
  await card.getByText('Your ads are being checked').waitFor();
  await card.getByText('420', { exact: true }).waitFor();
  await card.getByRole('link', { name: 'Book again' }).click();
  await page.getByRole('heading', { name: 'Book for Irani Chai' }).waitFor();
  await summary.getByText('₹1,48,680').waitFor();
  expect(await page.getByRole('checkbox', { name: 'Madhapur' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  expect(errors).toEqual([]);
  await page.close();
}, 90_000);

it('a POC brand: its months, a Pay button for the next, and its numbers by day (P7.8)', async () => {
  const pool = db.pool;
  const india = (t: number) => new Date((t + 19_800) * 1000).toISOString();
  const now = Math.floor(Date.now() / 1000);
  const ym = (t: number) => india(t).slice(0, 7);
  const monthStart = (m: string) => Date.parse(`${m}-01T08:00:00+05:30`) / 1000;
  // The POC switched on mid-month two months back: it began on the 1st of last month.
  const last = ym(monthStart(ym(now)) - 86_400);
  const before = ym(monthStart(last) - 86_400);
  const on = Date.parse(`${before}-15T11:00:00+05:30`) / 1000;
  await setBusinessMode(pool, 'poc', { id: 'prateek', role: 'super-admin' }, 'POC on', on);
  await createAccount(
    pool,
    {
      brandId: 'poc-chai',
      kind: 'brand',
      details: { name: 'POC Chai', agencyId: null, referredBy: null, active: true },
      by: 'Sana',
      reason: 'POC brand',
    },
    on,
  );
  const ads: string[] = [];
  for (const k of [1, 2]) {
    const adId = `AD-00000000F${k}`;
    await pool.query(
      `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, checks, outcome, uploaded_by, uploaded_at)
       VALUES ($1, 'poc-chai', $2, $3, 1000, 'png', '[]', 'pass', 'Sana', now())`,
      [adId, `Chai ad ${k}`, String(k).repeat(64)],
    );
    await pool.query(
      `INSERT INTO ad_reviews (ad_id, decision, checklist, reviewed_by, reviewed_at)
       VALUES ($1, 'approved', '{}', 'Prateek', now())`,
      [adId],
    );
    ads.push(adId);
  }
  await addPocBrand(
    pool,
    { brandId: 'poc-chai', firstMonth: last, months: 3, adIds: ads, reason: 'signed for 3 months' },
    'Sana',
    on + 60,
  );
  // Last month and this month paid before they started.
  for (const [i, m] of [last, ym(now)].entries()) {
    const link = await sendPocForPayment(pool, payments, `poc/poc-chai/${m}`, 'Sana', on + 120 + i);
    await applyLinkStatus(
      pool,
      link.linkId,
      {
        state: 'paid',
        paymentId: `pay_poc_${i}`,
        paidAt: on + 200 + i,
        amountPaise: link.amountPaise,
      },
      on + 200 + i,
    );
  }
  // A screen's signed plays near Hitech City on two recent evenings (plays older than 7 days when
  // they arrive are kept but never count).
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const screen = 'SCR-0000E2E1';
  await addScreenKey(
    pool,
    screen,
    'k1',
    key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
  let seq = 0;
  const plays: Numbered[] = [];
  const evenings = [3, 2].map((back) => india(now - back * 86_400).slice(0, 10));
  const shown = ym(Date.parse(`${evenings[1] ?? ''}T12:00:00Z`) / 1000);
  for (const date of evenings)
    for (let i = 0; i < 5; i++) {
      seq += 1;
      const body: Omit<PlayReport, 'sig'> = {
        kind: 'play',
        keyId: 'k1',
        slot: 'brand',
        ref: `poc/poc-chai/${date.slice(0, 7)}`,
        adId: ads[i % 2] ?? '',
        startAt: Date.parse(`${date}T19:00:00+05:30`) / 1000 + i * 720,
        lengthS: 15,
        latE6: 17_455_000,
        lngE6: 78_385_000,
        accuracyM: 6,
        place: 'outside',
        people: 6,
      };
      const sig = sign('sha256', Buffer.from(playBytes(screen, seq, body)), {
        key: key.privateKey,
        dsaEncoding: 'der',
      }).toString('base64');
      plays.push({ seq, at: body.startAt + 15, report: { ...body, sig } });
    }
  await storeUpload(pool, screen, plays, 1, now);
  await setPortalMember(
    pool,
    {
      brandId: 'poc-chai',
      address: '+919800000077',
      role: 'owner',
      active: true,
      reason: 'owner',
      by: 'Sana',
    },
    now - 60,
  );

  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Mobile number').fill('98000 00077');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByText('We sent a 6-digit code on WhatsApp').waitFor();
  await page.getByLabel('Code').fill(lastCode('+919800000077'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'POC Chai' }).waitFor();
  await page.getByRole('link', { name: 'POC' }).click();
  await page.getByRole('heading', { name: 'Your POC package' }).waitFor();
  const months = page.getByRole('region', { name: 'Your months' });
  await expect.poll(() => months.getByText('Paid', { exact: true }).count()).toBe(2);
  // Pay waits for the rules to be agreed (one tick).
  const pay = months.getByRole('button', { name: 'Pay' });
  await pay.waitFor();
  expect(await pay.isDisabled()).toBe(true);
  await months.getByLabel('I agree to these rules for the months I pay').check();
  expect(await pay.isDisabled()).toBe(false);
  // The month of the last evening in numbers: its plays, one bike; people only as an estimate.
  await page
    .getByRole('button', {
      name: new RegExp(
        `^${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(shown.slice(5)) - 1]}`,
      ),
    })
    .click();
  const numbers = page.getByRole('region', { name: / in numbers$/ });
  await numbers.getByText('Different bikes').waitFor();
  const expected = 5 * evenings.filter((d) => d.startsWith(shown)).length;
  await expect
    .poll(() => numbers.locator('.rc-stat__value').first().innerText())
    .toBe(String(expected));
  await numbers.getByText('an estimate, never billed').waitFor();
  await numbers.getByText('Plays by day').waitFor();
  // Paying next month makes its link (the button then goes to the payment page).
  const next = await page.evaluate(
    async (m) => {
      const r = await fetch(`/api/poc/pay?brand=poc-chai&month=${m}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agree: true, termsVersion: 1 }),
      });
      return { status: r.status, body: (await r.json()) as { url?: string } };
    },
    ym(monthStart(ym(now)) + 32 * 86_400),
  );
  expect(next.status).toBe(200);
  expect(next.body.url).toMatch(/^https:\/\//);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/brand-poc.png`, fullPage: true });
  expect(errors).toEqual([]);
  await page.close();
}, 90_000);

it('our areas: an animated map with the areas listed beside it; on the Book page, picks stand out (P5.4.1)', async () => {
  await setPortalMember(
    db.pool,
    {
      brandId: 'chai-co',
      address: 'maps@chaico.in',
      role: 'booker',
      active: true,
      reason: 'marketing',
      by: 'Sana',
    },
    Math.floor(Date.now() / 1000) - 10,
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SITE}/sign-in`);
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Work email').fill('maps@chaico.in');
  await page.getByRole('button', { name: 'Send code by email' }).click();
  await page.getByText('by email to maps@chaico.in').waitFor();
  await page.getByLabel('Code').fill(lastCode('maps@chaico.in'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Chai Co' }).waitFor();

  // From the top bar. The map's worker is allowed by the content rules, nothing from outside.
  const res = page.waitForResponse((r) => r.url().includes('/areas?brand='));
  await page.getByRole('link', { name: 'Our areas' }).click();
  const csp = (await res).headers()['content-security-policy'] ?? '';
  expect(csp).toContain("worker-src 'self'");
  expect(csp).toContain("connect-src 'self';");
  await page.getByRole('heading', { name: 'Our areas' }).waitFor();
  const list = page.getByRole('list', { name: 'Our areas' });
  await list.getByRole('button').first().waitFor();
  // The six launch areas, by name, each with its size.
  const names = await list.locator('.areas-map__name').allInnerTexts();
  expect(names).toEqual([
    'Banjara Hills',
    'Gachibowli',
    'Hitech City',
    'Jubilee Hills',
    'Kondapur',
    'Madhapur',
  ]);
  for (const s of await list.locator('.areas-map__size').allInnerTexts())
    expect(s).toMatch(/^\d+\.\d km²$/);
  // The map draws (the outlines one by one), then says it is done.
  await page.locator('.areas-map__map canvas, .areas-map__svg').first().waitFor();
  if (SHOTS) {
    await page.waitForTimeout(700);
    await page.locator('.areas-map').screenshot({ path: `${SHOTS}/brand-areas-drawing.png` });
  }
  await page.locator('.areas-map[data-state="drawn"]').waitFor();
  // Hover or focus a name: the area is highlighted, its name and size said.
  const card = page.locator('.areas-map__card');
  await list.getByRole('button', { name: /Madhapur/ }).hover();
  await card.getByText('Madhapur').waitFor();
  await card.getByText(/^\d+\.\d km²$/).waitFor();
  await list.getByRole('button', { name: /Kondapur/ }).focus();
  await card.getByText('Kondapur').waitFor();
  expect(await list.locator('.areas-map__item.hot').allInnerTexts()).toEqual([
    expect.stringContaining('Kondapur'),
  ]);
  await page.mouse.move(0, 0);
  await list.getByRole('button', { name: /Kondapur/ }).blur();
  // Enter on a name keeps it highlighted; Esc clears it.
  await list.getByRole('button', { name: /Gachibowli/ }).press('Enter');
  expect(await list.getByRole('button', { name: /Gachibowli/ }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  await page.keyboard.press('Escape');
  expect(await list.getByRole('button', { name: /Gachibowli/ }).getAttribute('aria-pressed')).toBe(
    'false',
  );

  // Screenshots: light and dark, desktop and a 360 px phone. At phone width nothing scrolls sideways.
  for (const scheme of ['light', 'dark'] as const) {
    for (const [width, height, name] of [
      [1280, 900, 'desktop'],
      [360, 780, 'phone'],
    ] as const) {
      const c = await browser.newContext({
        viewport: { width, height },
        colorScheme: scheme,
        storageState: await context.storageState(),
      });
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${SITE}/areas?brand=chai-co`);
      await p.locator('.areas-map[data-state="drawn"]').waitFor();
      await p
        .getByRole('list', { name: 'Our areas' })
        .getByRole('button', { name: /Madhapur/ })
        .click();
      expect(Number(await p.evaluate('document.documentElement.scrollWidth'))).toBeLessThanOrEqual(
        width,
      );
      if (SHOTS) {
        await p.evaluate('window.scrollTo(0, 0)');
        await p.waitForTimeout(400);
        await p.screenshot({ path: `${SHOTS}/brand-areas-${scheme}-${name}.png`, fullPage: true });
      }
      await c.close();
    }
  }

  // Reduced motion: no animation, everything is there at once.
  const calm = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
    storageState: await context.storageState(),
  });
  const still = await calm.newPage();
  await still.goto(`${SITE}/areas?brand=chai-co`);
  await still.locator('.areas-map__map canvas, .areas-map__svg').first().waitFor();
  // Drawn at the first frame after the map loads: far sooner than the ~3 s animation.
  const t0 = Date.now();
  await still.locator('.areas-map[data-state="drawn"]').waitFor();
  expect(Date.now() - t0).toBeLessThan(2_500);
  await calm.close();

  // The Book page: the same map; picking from the map ticks the area, and the map shows it.
  await page.goto(`${SITE}/book?brand=chai-co`);
  await page.getByRole('heading', { name: 'Book for Chai Co' }).waitFor();
  const bookList = page.getByRole('list', { name: 'Our areas' });
  await page.locator('.areas-map[data-state="drawn"]').waitFor();
  await bookList.getByRole('button', { name: /Madhapur/ }).click();
  await page.getByRole('button', { name: 'Pick Madhapur' }).click();
  expect(await page.getByRole('checkbox', { name: 'Madhapur' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  await bookList.locator('.areas-map__item.picked', { hasText: 'Madhapur' }).waitFor();
  await page.getByRole('checkbox', { name: 'Kondapur' }).click();
  await bookList.locator('.areas-map__item.picked', { hasText: 'Kondapur' }).waitFor();
  await page.locator('.areas-map__card').getByText('Picked', { exact: false }).waitFor();
  if (SHOTS) {
    await page.waitForTimeout(400);
    await page.evaluate('window.scrollTo(0, 0)');
    await page.screenshot({ path: `${SHOTS}/brand-book-map.png` });
  }
  await page.getByRole('button', { name: 'Remove Madhapur' }).click();
  expect(await page.getByRole('checkbox', { name: 'Madhapur' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  expect(errors).toEqual([]);
  await context.close();
}, 120_000);
