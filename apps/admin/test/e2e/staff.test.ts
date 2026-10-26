// The admin site in a real browser against the real API and a real database: the first super admin
// opens their invite, sets a password and the two-step code, signs in, adds an admin and signs out.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { fakeFileStore, fakePayments } from '@recall/adapters';
import { apiHandler, newToken, newTotpSecret, seal, tokenHash, totpCode } from '@recall/api';
import { launchAreas, newScreenId } from '@recall/domain';
import { addStaff, createAccount, saveAreaVersion, storeUpload } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { dayName } from '../../lib/format.js';
import { afterAll, beforeAll, expect, it } from 'vitest';

const PORT = 3101;
const SITE = `http://localhost:${PORT}`;
const KEY = randomBytes(32);
const PW = 'green kettle 42 mango';
const payments = fakePayments();
const files = fakeFileStore({ baseUrl: `${SITE}/api/files`, secret: 'e2e' });
const fixture = (name: string) =>
  new URL(`../../../../packages/domain/test/fixtures/ads/${name}`, import.meta.url).pathname;
let shift = 0;
const clock = () => Date.now() + shift;

let db: Awaited<ReturnType<typeof freshDatabase>>;
let api: Server;
let next: ChildProcess;
let browser: Browser;

beforeAll(async () => {
  db = await freshDatabase();
  api = createServer(
    apiHandler(
      db.pool,
      { secretKey: KEY, origins: [SITE], secureCookies: true, proxyHops: 1, payments, files },
      (l) => console.error(l),
      clock,
    ),
  );
  await new Promise<void>((ok) => api.listen(0, '127.0.0.1', ok));
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  // A site left over from an earlier run would answer instead of this one.
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
}, 120_000);

afterAll(async () => {
  await browser?.close();
  // The whole process group: npx and the Next server it started.
  if (next?.pid) process.kill(-next.pid, 'SIGTERM');
  await new Promise<void>((ok) => api.close(() => ok()));
  await db.drop();
});

const step = () => Math.floor(clock() / 30_000);
/** The super admin's two-step secret, from the first test. */
const SECRET = { value: '' };

it('first super admin: invite, sign in, add an admin, sign out', async () => {
  const token = newToken();
  await addStaff(db.pool, {
    email: 'prateek@recall.in',
    name: 'Prateek',
    access: { role: 'super-admin', areas: [] },
    byId: 'setup',
    reason: 'first super admin',
    invite: {
      tokenHash: tokenHash(token),
      totpSealed: seal(KEY, newTotpSecret()),
      untilMs: clock() + 48 * 3_600_000,
    },
    nowMs: clock(),
  });

  const page = await browser.newPage();
  const res = await page.goto(`${SITE}/invite#t=${token}`);
  const csp = res?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  // Scripts only with this page's own code; no inline scripts allowed.
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/);
  expect(csp).not.toContain("'unsafe-inline' 'strict");
  expect(res?.headers()['referrer-policy']).toBe('no-referrer');
  await page.getByText('Welcome, Prateek').waitFor();
  // The token is gone from the address (and the browser's history).
  expect(page.url()).toBe(`${SITE}/invite`);
  await expect(page.getByAltText('QR code for your authenticator app').isVisible()).resolves.toBe(
    true,
  );
  const secret = (await page.locator('.mono').innerText()).trim();
  SECRET.value = secret;
  await page.getByLabel('New password').fill(PW);
  await page.getByLabel('Password again').fill(PW);
  await page.getByLabel('The 6-digit code the app shows').fill(totpCode(secret, step()));
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('All set').waitFor();

  // The code that confirmed the invite cannot sign in: the next one does.
  shift += 30_000;
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(secret, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  // Today (P3.2): a super admin sees every part; an empty business shows zeros, not errors.
  await page.getByRole('heading', { name: 'Bikes now' }).waitFor();
  await page.getByRole('heading', { name: 'Hours sold and delivered' }).waitFor();
  await page.getByText('No open alerts.').waitFor();
  await page.getByText('None owed.').waitFor();
  const cookie = (await page.context().cookies()).find((c) => c.name === '__Host-recall_staff');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');

  await page.getByRole('link', { name: 'Staff' }).click();
  await page.getByRole('heading', { name: 'Staff' }).waitFor();
  await page.getByLabel('Name').fill('Meena Iyer');
  await page.getByLabel('Email').fill('meena@recall.in');
  await page.getByLabel('Role').selectOption('admin');
  await page.getByLabel('Finance').check();
  await page.getByLabel('Reason (logged)').fill('finance lead');
  await page.getByRole('button', { name: 'Add and make an invite link' }).click();
  await page.getByText('Meena Iyer added.').waitFor();
  await expect(page.locator('.mono').innerText()).resolves.toMatch(/\/invite#t=[A-Za-z0-9_-]{43}$/);
  await page.getByRole('cell', { name: 'Admin · Finance' }).waitFor();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
  await page.goto(`${SITE}/staff`);
  await page.getByRole('button', { name: 'Sign in' }).waitFor();
}, 120_000);

it('the pass-through takes only plain paths and small bodies', async () => {
  const big = await fetch(`${SITE}/api/staff/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE },
    body: JSON.stringify({ email: 'x'.repeat(20_000) }),
  });
  expect(big.status).toBe(413);
  for (const path of ['/api/staff/..%2Fhealth', '/api/staff%2Fme', '/api/staff/me.json']) {
    expect((await fetch(`${SITE}${path}`)).status, path).toBe(404);
  }
  // A plain query goes through; anything else is refused.
  expect((await fetch(`${SITE}/api/health?x=a;b`)).status).toBe(404);
  // An encoded value only rides with an upload; an upload with no sign-in is refused at once.
  expect((await fetch(`${SITE}/api/health?x=a%00`)).status).toBe(404);
  const anon = await fetch(`${SITE}/api/ads/upload?brand=x&name=a`, {
    method: 'POST',
    body: new Uint8Array(1024),
  });
  expect(anon.status).toBe(401);
  const ok = await fetch(`${SITE}/api/health`);
  expect(ok.status, await ok.text()).toBe(200);
});

it('the fleet map: bikes in the list, one bike in its panel, a command sent and logged', async () => {
  const now = Math.floor(clock() / 1000);
  const id = newScreenId([2, 7, 1, 8, 2, 8, 1]);
  await db.pool.query(
    `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
     VALUES ($1, 'RK-E2E-1', 'VendorX LED28 v1', 'warehouse-1', now())`,
    [id],
  );
  await db.pool.query(
    `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by)
     VALUES ($1, to_timestamp($2), 'TS09EA4321', 'R-77', 'first fitting', 'fitter')`,
    [id, now - 3600],
  );
  await storeUpload(
    db.pool,
    id,
    [
      {
        seq: 1,
        at: now - 20,
        report: {
          kind: 'live',
          t: now - 20,
          lat: 17.4435,
          lng: 78.3772,
          place: 'outside',
          moving: true,
        },
      },
    ],
    1,
    now,
  );

  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  // Sign in again (the first test signed out).
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Fleet map' }).click();
  await page.getByRole('heading', { name: 'Fleet map' }).waitFor();
  // The map draws (or, without WebGL, says it cannot, and the list still works).
  await page.locator('.fleet-map canvas, .fleet-map p').first().waitFor();
  await page.getByRole('button', { name: 'TS09EA4321' }).click();
  await page.getByText('R-77', { exact: true }).waitFor();
  await page.getByLabel('Command').selectOption('blank');
  await page.getByLabel('Reason (logged)').fill('rider asked');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/^Sent\./).waitFor();
  await page.getByText(/Blank the screen · waiting · Prateek/).waitFor();
  // A picture for the record when asked (SCREENSHOT_DIR), e.g. to show the page in review.
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/fleet-map.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
  // MapLibre's worker loaded and ran (a missing worker only shows as a console error).
  expect(consoleLines.filter((l) => l.startsWith('error'))).toEqual([]);
}, 120_000);

it('the Screens page: stock counts, a spare sent to repair with a reason', async () => {
  const spare = newScreenId([5, 3, 5, 8, 9, 7, 9]);
  await db.pool.query(
    `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
     VALUES ($1, 'RK-E2E-SPARE', 'VendorX LED28 v1', 'warehouse-1', now())`,
    [spare],
  );
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Screens' }).click();
  await page.getByRole('heading', { name: 'Screens', exact: true }).waitFor();
  await page.getByText('No update has been released yet.').waitFor();
  const row = page.getByRole('row', { name: new RegExp(spare) });
  await row.getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('What to do').selectOption('to-repair');
  await page.getByLabel('Reason (logged)').fill('dead pixels');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText(`${spare}: send to repair done.`).waitFor();
  await page.getByRole('row', { name: new RegExp(`${spare}.*In repair.*dead pixels`) }).waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('the Areas page: check a shape, save a new version with a reason, see it in the history', async () => {
  // In force since January (a new version must start after the one it replaces).
  for (const a of launchAreas('2026-01-01T00:00:00.000Z'))
    await saveAreaVersion(db.pool, { ...a, draft: false }, 'system');
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Areas' }).click();
  await page.getByRole('heading', { name: 'Areas', exact: true }).waitFor();
  await page
    .getByRole('row', { name: /Madhapur/ })
    .getByRole('button', { name: 'Open' })
    .click();
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('The shape passes every rule.').waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/areas.png`, fullPage: true });
  }
  await page.getByLabel('Edge zone (metres around the border, 0–2,000)').fill('250');
  await page.getByLabel('Reason (logged)').fill('narrower edge on the flyover');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('New version saved.').waitFor();
  await page
    .getByRole('row', { name: /Madhapur/ })
    .getByRole('button', { name: 'Open' })
    .click();
  await page.getByRole('row', { name: /^2 .*250 m.*narrower edge on the flyover/ }).waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('the Prices page: start with the plan’s prices, check and save a change, see it in the versions', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Prices' }).click();
  await page.getByRole('heading', { name: 'Prices and rules', exact: true }).waitFor();
  await page.getByText('No prices saved yet').waitFor();
  await page.getByLabel('Reason (kept with the version)').fill('launch prices');
  await page.getByRole('button', { name: 'Start with these prices' }).click();
  await page.getByText('Version 1 saved').waitFor();
  // A change: a price below the floor is refused by Check; a good one shows before and after.
  await page.getByLabel('Lite (₹ a bike-hour)').fill('200');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('Lite: below the floor').waitFor();
  await page.getByLabel('Lite (₹ a bike-hour)').fill('220');
  await page.getByLabel('Peak (₹ a bike-hour)').fill('320');
  await page.getByLabel('Band at 16:00').selectOption('Peak');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByText('The price rules allow this.').waitFor();
  await page.getByRole('row', { name: /Peak price a bike-hour ₹300 ₹320/ }).waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/prices.png`, fullPage: true });
  }
  // A new version must start after the last one (both "now", a second apart at least).
  shift += 2_000;
  await page.getByLabel('Reason (kept with the version)').fill('evening demand');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Version 2 saved').waitFor();
  await page.getByText(/Version 2 \(in force\)/).waitFor();
  await page.getByText(/evening demand/).waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('the Calendar page: a week of area-hours, a hold for a client from a cell, then released', async () => {
  await createAccount(
    db.pool,
    {
      brandId: 'chai-co',
      kind: 'brand',
      details: { name: 'Chai Co', agencyId: null, referredBy: null, active: true },
      by: 'test',
      reason: 'browser test',
    },
    Math.floor(clock() / 1000),
  );
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Calendar' }).click();
  await page.getByRole('heading', { name: 'Inventory calendar', exact: true }).waitFor();
  await page
    .getByRole('combobox', { name: 'Area', exact: true })
    .selectOption({ label: 'Madhapur' });
  const areaBox = page.getByRole('combobox', { name: 'Area', exact: true });
  await expect.poll(() => areaBox.inputValue()).toBe('hyd-madhapur');
  // Tomorrow's 19:00 cell (always in the future, whatever time the test runs).
  const tomorrow = new Date(clock() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  const day = dayName(tomorrow);
  await page.getByRole('button', { name: `${day} 19:00: 0 booked, no limit` }).click();
  await page.getByRole('heading', { name: `${day} 19:00` }).waitFor();
  await page.getByLabel('Limit (bikes; empty lifts it)').fill('40');
  await page
    .getByRole('form', { name: 'Manual limit' })
    .getByLabel('Why (logged)')
    .fill('flyover works');
  await page.getByRole('button', { name: 'Save limit' }).click();
  await page.getByText('Limit set to 40 bikes.').waitFor();
  await page.getByLabel('Brand id (e.g. chai-co)').fill('chai-co');
  await page.getByLabel('Bikes in each hour').fill('15');
  await page.getByLabel('Ends on (India time)').fill(tomorrow);
  await page.getByRole('form', { name: 'Hold' }).getByLabel('Why (logged)').fill('call on Monday');
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await page.getByText(/^Held: HLD-/).waitFor();
  const held = await db.pool.query<{ area_id: string }>(
    "SELECT DISTINCT area_id FROM hold_lines hl JOIN holds h USING (hold_id) WHERE h.brand_id = 'chai-co'",
  );
  expect(held.rows).toEqual([{ area_id: 'hyd-madhapur' }]);
  await page
    .getByRole('button', { name: `${day} 19:00: 0 booked · 15 held, 25 free of 40` })
    .waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/calendar.png`, fullPage: true });
  }
  await page.getByLabel('Why release it').fill('client said no');
  await page.getByRole('button', { name: 'Release' }).click();
  await page.getByText(/released: its bikes are on sale again/).waitFor();
  await page.getByText(/released .*client said no/).waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('the Brands page: add an agency and a brand it handles, a contact and a note', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Brands' }).click();
  await page.getByRole('heading', { name: 'Brands', exact: true }).waitFor();
  const add = async (kind: string, name: string, agency?: string) => {
    await page.getByRole('button', { name: 'Add a brand or agency' }).click();
    const form = page.getByRole('form', { name: 'New account' });
    await form.getByLabel('Kind').selectOption(kind);
    await form.getByLabel('Name').fill(name);
    if (agency) await form.getByLabel('Agency (brands only)').selectOption({ label: agency });
    await form.getByLabel('Why (logged)').fill('signed today');
    await form.getByRole('button', { name: 'Add' }).click();
    await page.getByText(`${name} added.`).waitFor();
  };
  await add('agency', 'Adwise Media');
  await add('brand', 'Dosa Co', 'Adwise Media');
  await page.getByRole('heading', { name: /Dosa Co · brand · dosa-co/ }).waitFor();
  const contact = page.getByRole('form', { name: 'Contact' });
  await contact.getByLabel('Mobile (+91)').fill('+91 98765 43210');
  await contact.getByRole('button', { name: 'Save contact' }).click();
  await page.getByText('Contact saved.').waitFor();
  await page.getByLabel('Add a note').fill('Wants evenings in Madhapur');
  await page.getByRole('button', { name: 'Add note' }).click();
  await page.getByText('Note added.').waitFor();
  await page.getByText('Wants evenings in Madhapur').waitFor();
  await page.getByRole('row', { name: /Dosa Co.*Adwise Media.*\+91 98765 43210/ }).waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/brands.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('booking for a brand: a draft from its page, the payment link, paid, the timeline', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Brands' }).click();
  await page
    .getByRole('row', { name: /Dosa Co/ })
    .getByRole('button', { name: 'Open' })
    .click();
  await page.getByRole('button', { name: 'New booking' }).click();
  const form = page.getByRole('form', { name: 'New booking' });
  const tomorrow = new Date(clock() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  await form.getByLabel('Area').selectOption({ label: 'Madhapur' });
  await form.getByLabel('First day').fill(tomorrow);
  await form.getByLabel('Last day').fill(tomorrow);
  await form.getByLabel('Bikes in each hour').fill('30');
  await form.getByLabel('19:00').check();
  await form.getByLabel('20:00').check();
  await form.getByRole('button', { name: 'Make the booking' }).click();
  await page.getByText(/^Draft booking BK-.* made\.$/).waitFor();
  const panel = page.getByRole('region', { name: /^Booking BK-/ });
  // Priced at the prices in force (an earlier test changed them), GST on top.
  await panel.getByText(/^₹[\d,]+ \+ GST ₹[\d,]+ = ₹[\d,]+$/).waitFor();
  await panel.getByRole('button', { name: 'Send payment link' }).click();
  await panel.getByText(/^Payment link ready: https:/).waitFor();
  // The brand pays on the provider's page (the fake provider here), and its message is lost.
  const link = [...payments.links.values()].at(-1);
  payments.pay(link?.linkId ?? '');
  await panel.getByRole('button', { name: 'Check payment' }).click();
  await panel.getByText('Paid.', { exact: true }).waitFor();
  await panel
    .getByRole('list', { name: 'Timeline' })
    .getByText(/^Payment received/)
    .waitFor();
  // Its ads: a 15-second video and a picture uploaded, both chosen; a 3-second video fails.
  const ads = panel.getByRole('region', { name: 'Ads' });
  const up = async (name: string, file: string) => {
    const form = ads.getByRole('form', { name: 'Upload an ad' });
    await form.getByLabel('Ad name').fill(name);
    await form.getByLabel('File (picture, or 15-second MP4)').setInputFiles(fixture(file));
    await form.getByRole('button', { name: 'Upload' }).click();
    await ads.getByRole('status').filter({ hasText: name }).waitFor();
  };
  await up('Evening video', 'ad-15s-1280x640.mp4');
  await up('Logo card', 'ad-1280x640.png');
  await up('Too short', 'ad-3s-1280x640.mp4');
  await ads
    .getByRole('listitem')
    .filter({ hasText: 'Too short' })
    .getByText(/cannot run: 3\.0 s/)
    .waitFor();
  expect(await ads.getByLabel('Run Too short').isDisabled()).toBe(true);
  await ads.getByLabel('Run Evening video').check();
  await ads.getByLabel('Run Logo card').check();
  await ads.getByRole('button', { name: 'Save the chosen ads' }).click();
  await ads.getByText('Ads saved for this booking.').waitFor();
  await ads.getByRole('heading', { name: /Ads \(2 chosen/ }).waitFor();
  // The previews load through signed links.
  await expect
    .poll(() =>
      ads
        .locator('img.ad-preview')
        .first()
        .evaluate((i) => (i as unknown as { naturalWidth: number }).naturalWidth),
    )
    .toBe(1280);
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/booking.png`, fullPage: true });
  }
  const bookingId = (await panel.getAttribute('aria-label'))?.replace('Booking ', '') ?? '';

  // P3.9.2: the reviewer approves both (every rule ticked).
  await page.getByRole('link', { name: 'Ad review' }).click();
  const queue = page.getByRole('region', { name: 'Waiting for review' });
  const card = (name: string) => queue.getByRole('listitem').filter({ hasText: name });
  await card('Evening video').getByText(`for ${bookingId}`).waitFor();
  // A file that failed the automatic checks never waits for a person (it can never run).
  expect(await card('Too short').count()).toBe(0);
  for (const name of ['Evening video', 'Logo card']) {
    const review = card(name).getByRole('form', { name: `Review ${name}` });
    expect(await review.getByRole('button', { name: 'Approve' }).isDisabled()).toBe(true);
    for (const box of await review.getByRole('checkbox').all()) await box.check();
    await review.getByRole('button', { name: 'Approve' }).click();
    await page
      .getByRole('status')
      .filter({ hasText: `${name}: approved.` })
      .waitFor();
  }
  // Its first hour is tomorrow: past the 7-day deadline, so it waits for a short-notice reason.
  await page.getByText(`${bookingId} waits: a short-notice approval needs a reason`).waitFor();
  const late = page.getByRole('region', { name: 'Short notice' });
  await late.getByLabel(`Why approve ${bookingId} on short notice`).fill('Brand sent files late');
  await late.getByRole('button', { name: `Approve ${bookingId}` }).click();
  await page.getByText(`${bookingId}: approved on short notice; ready to run.`).waitFor();
  await page
    .getByRole('region', { name: 'Latest decisions' })
    .getByText(/Logo card · .* · Approved by/)
    .waitFor();
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/reviews.png`, fullPage: true });

  // P3.10: its two hours on the Delivery page for that day, not yet started.
  await page.getByRole('link', { name: 'Delivery' }).click();
  await page.getByLabel('Business day').fill(tomorrow);
  const rows = page
    .getByRole('table', { name: 'Delivery' })
    .getByRole('row')
    .filter({ hasText: bookingId });
  await expect.poll(() => rows.count()).toBe(2);
  await rows.first().getByText('Upcoming', { exact: true }).waitFor();
  await rows.first().getByText('Upcoming: 6,000 plays promised').waitFor();
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/delivery.png`, fullPage: true });
  expect(errors).toEqual([]);
}, 120_000);

it('the Riders page: a walk-in rider added, his documents checked, approved, a note', async () => {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  shift += 30_000;
  await page.goto(`${SITE}/sign-in`);
  await page.getByLabel('Email').fill('prateek@recall.in');
  await page.getByLabel('Password').fill(PW);
  await page.getByLabel('Code from your authenticator app').fill(totpCode(SECRET.value, step()));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Prateek · Super admin').waitFor();
  await page.getByRole('link', { name: 'Riders' }).click();
  await page.getByRole('button', { name: 'New rider' }).click();
  const add = page.getByRole('form', { name: 'New rider' });
  await add.getByLabel('Name').fill('Ravi Kumar');
  await add.getByLabel('Phone (mobile)').fill('98480 12345');
  await add.getByLabel('Number plate').fill('ts 09 ea 1234');
  await add.getByLabel('Rides in').fill('Madhapur');
  await add.getByLabel('swiggy').check();
  await add.getByLabel('How he applied (logged)').fill('walk-in at the warehouse');
  await add.getByRole('button', { name: 'Add rider' }).click();
  await page.getByText(/^Rider RD-\d{6} added\.$/).waitFor();
  const panel = page.getByRole('region', { name: /^Rider RD-/ });
  await panel.getByText('+91 98480 12345').waitFor();
  await panel.getByText('TS09EA1234', { exact: true }).waitFor();

  // His documents, sent by Operations for him, then looked at.
  for (const [kind, file] of [
    ['Photo', 'ad-1280x640.jpg'],
    ['Registration (RC)', 'ad-1280x640.png'],
    ['Insurance', 'ad-1280x640.webp'],
  ] as const) {
    const send = panel.getByRole('form', { name: 'Send a document' });
    await send.getByLabel('Document').selectOption({ label: kind });
    await send.getByLabel('File (photo or PDF, up to 10 MB)').setInputFiles(fixture(file));
    await send.getByRole('button', { name: 'Send' }).click();
    await panel.getByText(`${kind} sent: waiting for a look.`).waitFor();
  }
  const approve = panel.getByRole('form', { name: 'Rider step' });
  await approve.getByLabel('Why (logged)').fill('documents not checked yet');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await panel
    .getByRole('alert')
    .getByText(/^not ready: Photo waiting for a look/)
    .waitFor();
  for (const kind of ['Photo', 'Registration (RC)', 'Insurance']) {
    const look = panel.getByLabel(`Look at ${kind}`);
    await look.getByLabel(`Why, ${kind}`).fill('matches the original');
    if (kind === 'Insurance') await look.getByLabel('Insurance covers until').fill('2099-03-31');
    await look.getByRole('button', { name: 'Accept' }).click();
    await panel.getByText(`${kind} accepted.`).waitFor();
  }
  await approve.getByLabel('Why (logged)').fill('all documents checked');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('status').getByText('Approved.').waitFor();
  await panel.getByRole('heading').getByText('Approved').waitFor();
  const note = panel.getByRole('form', { name: 'Rider note' });
  await note.getByLabel('Add a note').fill('Fitting booked for Monday');
  await note.getByRole('button', { name: 'Add note' }).click();
  await panel
    .getByRole('list', { name: 'Timeline' })
    .getByText('Note: Fitting booked for Monday')
    .waitFor();

  // Found again by name with a space in it.
  await page.getByLabel('Name, phone, id or plate').fill('Ravi Kum');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect
    .poll(() => page.getByRole('table', { name: 'Riders' }).getByRole('row').count())
    .toBe(2);
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/riders.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);
