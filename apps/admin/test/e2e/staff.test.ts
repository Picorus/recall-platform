// The admin site in a real browser against the real API and a real database: the first super admin
// opens their invite, sets a password and the two-step code, signs in, adds an admin and signs out.
// Needs `next build` first and DATABASE_URL (pnpm services:up).
import { apiHandler, newToken, newTotpSecret, seal, tokenHash, totpCode } from '@recall/api';
import { addStaff } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
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
  const ok = await fetch(`${SITE}/api/health`);
  expect(ok.status, await ok.text()).toBe(200);
});
