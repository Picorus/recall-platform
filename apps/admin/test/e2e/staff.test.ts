// The admin site in a real browser against the real API and a real database: the first super admin
// opens their invite, sets a password and the two-step code, signs in, adds an admin and signs out.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import {
  fakeBankCheck,
  fakeEsign,
  fakeFileStore,
  fakeInbound,
  fakeKyc,
  fakeMaps,
  fakeMessages,
  fakePayments,
  fakePayouts,
} from '@recall/adapters';
import { apiHandler, newToken, newTotpSecret, seal, tokenHash, totpCode } from '@recall/api';
import { launchAreas, moneyToReturn, newScreenId, refundApproved } from '@recall/domain';
import {
  addStaff,
  createAccount,
  createBooking,
  moveBooking,
  post,
  preparePayoutRun,
  saveAreaVersion,
  setBrandContact,
  storeUpload,
} from '@recall/db';
import { checkedPayoutAccount, freshDatabase } from '@recall/db/test-db';
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
const messages = fakeMessages();
const inbound = fakeInbound();
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
      {
        secretKey: KEY,
        origins: [SITE],
        secureCookies: true,
        proxyHops: 1,
        payments,
        files,
        riderChecks: {
          kyc: fakeKyc({ auto: true }),
          esign: fakeEsign({ auto: true }),
          bank: fakeBankCheck(),
        },
        payouts: fakePayouts(),
        reports: { maps: fakeMaps(), messages, portalUrl: 'http://localhost:3000' },
        inbound,
        connections: [{ service: 'Brand payments', state: 'stand-in', provider: 'fake' }],
      },
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

it('the Settings page: a fitting centre added, a support number refused then saved', async () => {
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
  await page.getByRole('link', { name: 'Settings' }).click();
  const centres = page.getByRole('region', { name: 'Fitting centres' });
  await centres.getByText('No centre yet.').waitFor();
  await centres.getByLabel('New centre').fill('Kukatpally warehouse');
  await centres.getByLabel('Its address').fill('Plot 4, KPHB Phase 1, Kukatpally');
  await centres.getByRole('button', { name: 'Add centre' }).click();
  await centres.getByLabel('Why').fill('First fitting centre');
  await centres.getByRole('button', { name: 'Save' }).click();
  await centres.getByText(/^Version 1, saved by Prateek .*: First fitting centre$/).waitFor();
  // A wrong number is refused in words; then saved.
  const support = page.getByRole('region', { name: 'Support numbers and hours' });
  await support.getByText(/Support is (open|closed) now/).waitFor();
  await support.getByRole('button', { name: 'Add a number' }).click();
  await support.getByLabel('For').fill('Riders');
  await support.getByLabel('Number').fill('+91 12345');
  await support.getByLabel('Why').fill('Rider helpline');
  await support.getByRole('button', { name: 'Save' }).click();
  await support.getByRole('alert').getByText('Support number: +91 and 10 digits').waitFor();
  await support.getByLabel('Number').fill('+91 98480 12345');
  await support.getByRole('button', { name: 'Save' }).click();
  await support.getByText(/^Version 1, saved by Prateek/).waitFor();
  expect(await support.getByLabel('Number').inputValue()).toBe('+919848012345');
  await page.getByRole('table', { name: 'Connections' }).getByText('Brand payments').waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/settings.png`, fullPage: true });
  }
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
  const approve = panel.getByRole('group', { name: 'Rider step' });
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
  // Identity, the agreement and a UPI id checked with ₹1 (the providers' fakes pass at once).
  const checks = panel.getByRole('list', { name: 'Checks' });
  await checks
    .getByRole('listitem')
    .filter({ hasText: 'Identity (KYC)' })
    .getByRole('button', { name: 'Start' })
    .click();
  await panel.getByText('Identity check started: send him the link below.').waitFor();
  await checks
    .getByRole('listitem')
    .filter({ hasText: 'Agreement' })
    .getByRole('button', { name: 'Send' })
    .click();
  await panel.getByText('Agreement ready: send him the link below to sign.').waitFor();
  const bank = panel.getByRole('form', { name: 'Check a bank account or UPI' });
  await bank.getByLabel('UPI id').fill('ravi@okaxis');
  await bank.getByLabel("Holder's name").fill('Ravi Kumar');
  await bank.getByRole('button', { name: 'Check with ₹1' }).click();
  await panel.getByText('Bank check passed: the bank holds it as RAVI KUMAR.').waitFor();
  await panel.getByText('Paid to: UPI ravi@okaxis · Ravi Kumar').waitFor();
  // Enter in the reason never moves him.
  await approve.getByLabel('Why (logged)').fill('all documents checked');
  await approve.getByLabel('Why (logged)').press('Enter');
  await approve.getByLabel('Why (logged)').fill('all documents checked');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await panel.getByRole('status').getByText('Approved.').waitFor();
  await panel.getByRole('heading').getByText('Approved').waitFor();

  // P3.11.3: a fitting slot tomorrow at 10:00 (India time), and his booking in it.
  const day = new Date(clock() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  const slots = page.getByRole('region', { name: 'Fitting slots' });
  const openSlot = slots.getByRole('form', { name: 'Open a fitting slot' });
  await openSlot.getByLabel('Centre').selectOption('Kukatpally warehouse');
  await openSlot.getByLabel('Starts (India time)').fill(`${day}T10:00`);
  await openSlot.getByRole('button', { name: 'Open slot' }).click();
  await slots.getByText(/Kukatpally warehouse \(0 of 4 booked\)/).waitFor();
  const book = panel.getByRole('group', { name: 'Book a fitting' });
  const option = book.getByRole('option', { name: /Kukatpally warehouse/ });
  await book.getByLabel('Slot').selectOption((await option.getAttribute('value')) ?? '');
  await book.getByRole('button', { name: 'Book' }).click();
  await panel.getByText(/^Booked: .* Kukatpally warehouse \(1 of 4 booked\)$/).waitFor();
  await panel.getByText('Owed now:').waitFor();
  await panel
    .getByRole('list', { name: 'If he leaves' })
    .getByText(/Screen returned: no screen/)
    .waitFor();
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

it('the Payouts page: the Monday run approved, a line held and released, then paid', async () => {
  // A rider owed ₹1,500 with a checked UPI, and this week's run prepared by itself.
  const rider = 'RD-000990';
  await checkedPayoutAccount(db.pool, rider, { kind: 'upi', vpa: 'kiran@okaxis', name: 'Kiran' });
  await post(
    db.pool,
    {
      entryId: `e2e-pay-${rider}`,
      at: Math.floor(clock() / 1000),
      kind: 'rider-pay',
      ref: rider,
      memo: 'e2e',
      postings: [
        { account: 'rider-earnings', debit: 150_000, credit: 0 },
        { account: 'rider-payable', debit: 0, credit: 150_000, party: rider },
      ],
    },
    'e2e',
  );
  const india = new Date(clock() + 330 * 60_000);
  india.setUTCDate(india.getUTCDate() - ((india.getUTCDay() + 6) % 7));
  const monday = india.toISOString().slice(0, 10);
  await preparePayoutRun(db.pool, monday, Math.floor(clock() / 1000), 'system');

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
  await page.getByRole('link', { name: 'Payouts' }).click();
  const run = page.getByRole('region', { name: `Run for ${dayName(monday)}` });
  await run.getByRole('heading').getByText('Waiting for approval').waitFor();
  const lines = run.getByRole('table', { name: 'Payout lines' });
  await lines.getByText('UPI kiran@okaxis · Kiran').waitFor();
  await run.getByRole('button', { name: 'Approve' }).click();
  await run.getByText('Approved. It can be sent now.').waitFor();
  await run.getByLabel(`Why, ${rider}`).fill('he called about his UPI');
  await run.getByRole('button', { name: 'Hold' }).click();
  await run.getByText(`${rider}: held.`).waitFor();
  // Everything held: nothing to send.
  await lines.getByText('Held', { exact: true }).waitFor();
  expect(await run.getByRole('button', { name: 'Send' }).count()).toBe(0);
  await run.getByLabel(`Why, ${rider}`).fill('UPI confirmed');
  await run.getByRole('button', { name: 'Release' }).click();
  await run.getByText(`${rider}: released.`).waitFor();
  await run.getByRole('button', { name: 'Send' }).click();
  await run.getByText(/^Sent: 1 paid,/).waitFor();
  await run.getByRole('heading').getByText('Done').waitFor();
  await lines.getByText('Paid', { exact: true }).waitFor();
  await page
    .getByRole('table', { name: 'Payout runs' })
    .getByText('₹1,500 of ₹1,500 paid')
    .waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/payouts.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('the Money page: where money stands, the payment and its tax invoice, the accountant files', async () => {
  // Owed back: a ₹590 refund on the booking paid earlier, and a payment for a link we never knew.
  const paid = await db.pool.query<{ booking_id: string; brand_id: string }>(
    `SELECT l.booking_id, b.brand_id FROM payment_link_events e JOIN payment_links l USING (link_id)
       JOIN bookings b ON b.booking_id = l.booking_id WHERE e.state = 'paid' LIMIT 1`,
  );
  const bk = paid.rows[0]?.booking_id ?? '';
  const nowS = Math.floor(clock() / 1000);
  await post(
    db.pool,
    refundApproved({
      refundId: `${bk}/e2e#refund`,
      lineId: `${bk}/e2e`,
      brandId: paid.rows[0]?.brand_id ?? '',
      base: 50_000,
      gst: 9_000,
      at: nowS,
    }),
    'e2e',
  );
  await post(
    db.pool,
    moneyToReturn({
      paymentId: 'pay_e2e_stray',
      ref: 'lnk_stray',
      amount: 25_000,
      why: 'unknown link',
      at: nowS + 1,
    }),
    'e2e',
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
  await page.getByRole('link', { name: 'Money' }).click();
  // The booking paid in the earlier test: held for its campaign, one payment, one invoice.
  await page.getByRole('region', { name: 'Where money stands now' }).waitFor();
  const pays = page.getByRole('table', { name: 'Payments' });
  await pays.getByText('Paid', { exact: true }).waitFor();
  await expect.poll(() => pays.getByRole('row').count()).toBe(2);
  const docs = page.getByRole('table', { name: 'Tax documents' });
  await expect.poll(() => docs.getByRole('row').count()).toBe(2);
  const back = page.getByRole('table', { name: 'Money owed back' });
  await back
    .getByRole('row')
    .filter({ hasText: 'Refund (credit note)' })
    .getByRole('button', { name: 'Send back' })
    .click();
  await page.getByText(/^₹590 sent back to /).waitFor();
  // The stray payment is unknown to the provider: paid by bank transfer instead.
  const transfer = back.getByRole('group', { name: 'Bank transfer, to-return:pay_e2e_stray' });
  await transfer.getByLabel('Bank reference (UTR)').fill('HDFCR52026102700001');
  await transfer.getByRole('button', { name: 'Record bank transfer' }).click();
  await page.getByText(/: bank transfer recorded\.$/).waitFor();
  await page
    .getByRole('region', { name: 'Owed back to brands' })
    .getByText('Nothing owed back.')
    .waitFor();
  // P3.13.3: a cut for an agency on the paid booking; its statement; their invoice recorded.
  const partnersCard = page.getByRole('region', { name: 'Agencies and aggregators' });
  const give = partnersCard.getByRole('form', { name: 'Give a cut on a booking' });
  await give.getByLabel('Booking').fill(bk);
  await give.getByLabel('Partner id').fill('adwise');
  await give.getByLabel('Why (logged)').fill('agency brought this brand');
  await give.getByRole('button', { name: 'Give cut' }).click();
  await give.getByText(`Cut given on ${bk}.`).waitFor();
  const partnerRow = partnersCard
    .getByRole('table', { name: 'Partners' })
    .getByRole('row', { name: /adwise/ });
  await partnerRow.getByRole('button', { name: 'Statement' }).click();
  const statement = partnersCard.getByRole('region', { name: 'Statement of adwise' });
  await statement.getByText('Owed at the end').waitFor();
  const inv = statement.getByRole('form', { name: 'Record their invoice' });
  await inv.getByLabel('Invoice number').fill('AW/26/001');
  await inv.getByLabel('Date').fill(new Date(clock() + 330 * 60_000).toISOString().slice(0, 10));
  await inv.getByLabel('Before GST (₹)').fill('100');
  await inv.getByRole('button', { name: 'Record invoice' }).click();
  await statement.getByText('Invoice AW/26/001 of adwise recorded.').waitFor();
  // Nothing delivered yet, so nothing owed: a payment is refused.
  const pay = statement.getByRole('form', { name: 'Record a payment' });
  await pay.getByLabel('Paid (₹)').fill('100');
  await pay.getByLabel('Bank reference (UTR)').fill('UTR12345678');
  await pay.getByRole('button', { name: 'Record payment' }).click();
  await statement
    .getByRole('alert')
    .getByText(/adwise is owed nothing/)
    .waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download files for the accountant' }).click();
  expect((await download).suggestedFilename()).toMatch(/^invoices-\d{4}-\d{2}\.csv$/);
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/money.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('the Reports page: an ended campaign, its report as the brand sees it, sent again by email', async () => {
  // A campaign booked now for tomorrow evening; then the clock moves four days on: it has ended and
  // its report is built (the build itself is tested elsewhere).
  const day = new Date(clock() + 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
  const startAt = (h: number) =>
    Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00+05:30`) / 1000;
  const booked = Math.floor(clock() / 1000);
  await createBooking(
    db.pool,
    {
      bookingId: 'BK-E2E-REPORT',
      brandId: 'dosa-co',
      request: {
        // Six peak hours of 10 bikes (₹18,000): the laptop's supply has room for 10.
        lines: [17, 18, 19, 20, 21, 22].map((startHour) => ({
          areaId: 'hyd-madhapur',
          date: day,
          startHour,
          bikes: 10,
        })),
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'e2e',
    },
    booked,
  );
  const sys = { by: 'system', actor: 'system' } as const;
  await moveBooking(
    db.pool,
    'BK-E2E-REPORT',
    'awaiting-payment',
    { by: 'e2e', actor: 'admin' },
    booked,
  );
  await moveBooking(db.pool, 'BK-E2E-REPORT', 'paid', sys, booked + 60);
  await moveBooking(
    db.pool,
    'BK-E2E-REPORT',
    'ads-approved',
    { by: 'e2e', actor: 'admin', reason: 'test campaign for the report' },
    booked + 120,
  );
  await moveBooking(db.pool, 'BK-E2E-REPORT', 'running', sys, startAt(17));
  await moveBooking(db.pool, 'BK-E2E-REPORT', 'done', sys, startAt(23));
  const report = {
    bookingId: 'BK-E2E-REPORT',
    brandId: 'dosa-co',
    from: startAt(17),
    until: startAt(23),
    builtAt: startAt(23) + 48 * 3600,
    lines: [],
    promised: 12_000,
    delivered: 11_400,
    deliveredBp: 9_500,
    missing: 600,
    bikes: 57,
    makeUps: { opened: 0, plays: 0 },
    heatMap: [],
    streets: [],
    people: { low: 30_000, high: 40_000, approximate: true, text: '30,000–40,000 (approximate)' },
  };
  await db.pool.query(
    `INSERT INTO campaign_reports (booking_id, built_at, report) VALUES ($1, to_timestamp($2), $3)`,
    ['BK-E2E-REPORT', report.builtAt, JSON.stringify(report)],
  );
  await setBrandContact(db.pool, 'dosa-co', { email: 'dosa@example.in' }, 'e2e');
  shift += 4 * 86_400_000;

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
  await page.getByRole('link', { name: 'Reports' }).click();
  const row = page
    .getByRole('table', { name: 'Reports' })
    .getByRole('row', { name: /BK-E2E-REPORT/ });
  await row.getByText('11,400 of 12,000 (95%)').waitFor();
  await row.getByText('Built, being sent').waitFor();
  await row.getByRole('button', { name: 'Open' }).click();
  const panel = page.getByRole('region', { name: 'Report BK-E2E-REPORT' });
  await panel
    .frameLocator('iframe')
    .getByText(/BK-E2E-REPORT/)
    .first()
    .waitFor();
  await panel.getByRole('button', { name: 'Send again by email' }).click();
  await panel.getByText('Sent again on email.').waitFor();
  await row.getByText('Email: Sent to dosa@example.in').waitFor();
  expect(messages.sent.map((m) => m.to)).toContain('dosa@example.in');
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/reports.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('the Dashboard: this month so far and month by month', async () => {
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
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('region', { name: 'This month' }).getByText('Bike-hours sold').waitFor();
  await expect
    .poll(() => page.getByRole('table', { name: 'Month by month' }).getByRole('row').count())
    .toBe(7);
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/dashboard.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('the Support page: a WhatsApp message from a rider, answered, noted and done', async () => {
  // Ravi Kumar (the rider added earlier, +91 98480 12345) writes on WhatsApp.
  const post = inbound.message({
    channel: 'whatsapp',
    providerId: 'wamid.e2e.1',
    from: '+919848012345',
    text: 'My screen is not turning on',
    at: Math.floor(clock() / 1000),
  });
  const r = await fetch(`http://127.0.0.1:${(api.address() as AddressInfo).port}/support/inbound`, {
    method: 'POST',
    headers: { 'x-message-signature': post.signature },
    body: post.body,
  });
  expect(r.status).toBe(200);

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
  await page.getByRole('link', { name: 'Support' }).click();
  const row = page.getByRole('table', { name: 'Inbox' }).getByRole('row', { name: /Ravi Kumar/ });
  await row.getByText(/^waiting \d+ min$/).waitFor();
  await row.getByRole('button', { name: 'Open' }).click();
  const conv = page.getByRole('region', { name: /^Conversation SUP-/ });
  await conv
    .getByRole('list', { name: 'History' })
    .getByText('My screen is not turning on')
    .waitFor();
  await conv
    .getByLabel('Reply on WhatsApp (they see this)')
    .fill('We will call you in 10 minutes.');
  await conv.getByRole('button', { name: 'Send reply' }).click();
  await conv.getByText('Reply sent.').waitFor();
  expect(messages.sent.at(-1)).toMatchObject({ to: '+919848012345', template: 'support_reply' });
  await conv.getByLabel('Note (staff only)').fill('Loose cable; fixed at the warehouse.');
  await conv.getByRole('button', { name: 'Add note' }).click();
  await conv.getByText('Note added.').waitFor();
  await conv.getByLabel('Why (logged)').fill('screen fixed');
  await conv.getByRole('button', { name: 'Done', exact: true }).click();
  await conv.getByText('Done.', { exact: true }).waitFor();
  await page.getByText('Nothing here.').waitFor();
  if (process.env.SCREENSHOT_DIR) {
    await page.getByLabel('Show').selectOption('done');
    await page.getByRole('table', { name: 'Inbox' }).waitFor();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/support.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);

it('the Audit log: every change, searched and paged', async () => {
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
  await page.getByRole('link', { name: 'Audit log' }).click();
  const log = page.getByRole('table', { name: 'Audit log' });
  await log.getByText('signed in').first().waitFor();
  // The rider added on the Riders page, found by name.
  const search = page.getByRole('form', { name: 'Search the log' });
  await search.getByLabel('Find (who, what, booking, rider…)').fill('walk-in');
  await search.getByRole('button', { name: 'Search' }).click();
  await log.getByText('rider details set').first().waitFor();
  await search.getByLabel('Find (who, what, booking, rider…)').fill('');
  await search.getByLabel('Part').selectOption('riders');
  await search.getByRole('button', { name: 'Search' }).click();
  await expect
    .poll(async () =>
      (await log.getByRole('row').allTextContents()).slice(1).every((t) => t.includes('riders')),
    )
    .toBe(true);
  if (process.env.SCREENSHOT_DIR) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/audit.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
}, 120_000);
