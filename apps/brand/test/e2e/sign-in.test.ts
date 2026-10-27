// The brand portal in a real browser against the real API and a real database (P5.1): a new
// business signs in with a WhatsApp code and is welcomed; a person RECALL's team gave access signs
// in by email and sees their brand; wrong codes are told; sign-out ends it.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { fakeGst, fakeMessages } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import { apiHandler } from '@recall/api';
import {
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
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

const PORT = 3102;
const SITE = `http://localhost:${PORT}`;
const messages = fakeMessages();
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
  await savePriceBook(db.pool, PRICE_BOOK_V1, 'prateek');
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
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
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
  // The site passes only the portal's routes: a staff route is not reachable through it.
  const staff = await page.evaluate(async () => (await fetch('/api/staff/me')).status);
  expect(staff).toBe(404);
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
  // In its campaigns, to pay; "Book again" opens with the same plan.
  await page.getByRole('heading', { name: 'Irani Chai' }).waitFor();
  const card = page.getByRole('listitem', { name: /^Campaign BK-/ });
  await card.getByText('To pay').waitFor();
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
