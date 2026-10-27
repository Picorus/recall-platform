// The brand portal in a real browser against the real API and a real database (P5.1): a new
// business signs in with a WhatsApp code and is welcomed; a person RECALL's team gave access signs
// in by email and sees their brand; wrong codes are told; sign-out ends it.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { fakeGst, fakeMessages } from '@recall/adapters';
import { PRICE_BOOK_V1 } from '@recall/domain';
import { apiHandler } from '@recall/api';
import { createAccount, savePriceBook, saveSetting, setPortalMember } from '@recall/db';
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
}, 60_000);

it('a person given access signs in by email and sees their brand', async () => {
  const page = await browser.newPage();
  await page.goto(`${SITE}/sign-in`);
  await page.getByRole('button', { name: 'Email' }).click();
  await page.getByLabel('Work email').fill('Media@ChaiCo.in');
  await page.getByRole('button', { name: 'Send code by email' }).click();
  await page.getByText('by email to media@chaico.in').waitFor();
  await page.getByLabel('Code').fill(lastCode('media@chaico.in'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Your accounts' }).waitFor();
  await page.getByText('Chai Co').waitFor();
  await page.getByText('Brand · Owner').waitFor();
  // The site passes only the portal's routes: a staff route is not reachable through it.
  const staff = await page.evaluate(async () => (await fetch('/api/staff/me')).status);
  expect(staff).toBe(404);
  await page.close();
}, 60_000);

it('a new business sets itself up from its GST number and sees its free week (P5.2)', async () => {
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
  // Its first page now lists it.
  await page.goto(SITE);
  await page.getByRole('link', { name: 'Irani Chai' }).waitFor();
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);
