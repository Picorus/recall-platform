// The admin site in a real browser against the real API and a real database: the first super admin
// opens their invite, sets a password and the two-step code, signs in, adds an admin and signs out.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { apiHandler, newToken, newTotpSecret, seal, tokenHash, totpCode } from '@recall/api';
import { launchAreas, newScreenId } from '@recall/domain';
import { addStaff, saveAreaVersion, storeUpload } from '@recall/db';
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
      { secretKey: KEY, origins: [SITE], secureCookies: true, proxyHops: 1 },
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
  expect((await fetch(`${SITE}/api/health?x=1%2F..`)).status).toBe(404);
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
