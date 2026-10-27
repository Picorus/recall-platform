// The rider app (web build) in a real browser against the real API and a real database (P4.1):
// language, a wrong number, a code on WhatsApp, a wrong code, signed in as a known rider, still
// signed in after a reload, signed out; a new number by SMS in Hindi is welcomed to the sign-up.
// Needs `pnpm test:e2e` (it builds the app for the web first) and DATABASE_URL (pnpm services:up).
import { fakeMessages } from '@recall/adapters';
import { apiHandler } from '@recall/api';
import { createRider } from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The app is built to call this API address (package.json, test:e2e).
const API_PORT = 18381;
const SITE_PORT = 18382;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const DIST = new URL('../../dist-e2e/', import.meta.url).pathname;
const messages = fakeMessages();

let db: Awaited<ReturnType<typeof freshDatabase>>;
let api: Server;
let site: Server;
let browser: Browser;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
};

beforeAll(async () => {
  db = await freshDatabase();
  api = createServer(
    apiHandler(
      db.pool,
      {
        secretKey: randomBytes(32),
        origins: ['http://localhost:3001'],
        secureCookies: true,
        proxyHops: 0,
        messages,
        riderOrigins: [SITE],
      },
      (l) => console.error(l),
    ),
  );
  await new Promise<void>((ok) => api.listen(API_PORT, '127.0.0.1', ok));
  // The web build, served as a phone would load it.
  site = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
    const file = join(DIST, path.endsWith('/') ? 'index.html' : path);
    readFile(file.startsWith(DIST) ? file : join(DIST, 'index.html'))
      .catch(() => readFile(join(DIST, 'index.html')))
      .then((body) => {
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html; charset=utf-8' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404);
        res.end();
      });
  });
  await new Promise<void>((ok) => site.listen(SITE_PORT, '127.0.0.1', ok));
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
  await new Promise<void>((ok) => (api ? api.close(() => ok()) : ok()));
  await db?.drop();
});

/** The code in the newest message to a number. */
const codeFor = (to: string) => {
  const m = [...messages.sent].reverse().find((x) => x.to === to);
  return m?.channel === 'whatsapp'
    ? (m.params[0] ?? '')
    : m?.channel === 'sms'
      ? m.text.slice(0, 6)
      : '';
};

async function phonePage(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(SITE);
  return { page, errors };
}

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR)
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
};

it('a known rider signs in with a WhatsApp code, stays signed in, and signs out', async () => {
  await createRider(
    db.pool,
    {
      details: { name: 'Ravi Kumar', phone: '+919848012345', bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    Math.floor(Date.now() / 1000) - 3600,
  );
  const { page, errors } = await phonePage();
  await page.getByText('Earn while you ride.').waitFor();
  // Telugu, then back to English.
  await page.getByRole('radio', { name: 'తెలుగు' }).click();
  await page.getByText('నడుపుతూ సంపాదించండి.').waitFor();
  await shot(page, 'rider-sign-in-te');
  await page.getByRole('radio', { name: 'English' }).click();
  await shot(page, 'rider-sign-in');
  // A number that is not one.
  await page.getByLabel('Mobile number').fill('12345');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByRole('alert').getByText('Type your 10-digit mobile number.').waitFor();
  await page.getByLabel('Mobile number').fill('98480 12345');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByText('Type the code').waitFor();
  await page.getByText(/on WhatsApp to \+91\s98480\s12345/).waitFor();
  expect(messages.sent.at(-1)).toMatchObject({ template: 'sign_in_code', language: 'en' });
  // A new code only after 30 seconds.
  await expect(page.getByRole('button', { name: /New code in \d+ s/ }).isDisabled()).resolves.toBe(
    true,
  );
  const code = codeFor('+919848012345');
  await page.getByLabel('Code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').getByText('Wrong code. 4 tries left.').waitFor();
  await shot(page, 'rider-code');
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Ravi Kumar').waitFor();
  await page.getByText('Your application is with us. We will call you.').waitFor();
  await shot(page, 'rider-home');
  // Still signed in after the app is opened again.
  await page.reload();
  await page.getByText('Ravi Kumar').waitFor();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByText('Earn while you ride.').waitFor();
  await page.reload();
  await page.getByText('Earn while you ride.').waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('a new number by SMS, in Hindi: welcomed to the sign-up', async () => {
  const { page, errors } = await phonePage();
  await page.getByRole('radio', { name: 'हिन्दी' }).click();
  await page.getByLabel('मोबाइल नंबर').fill('9000011111');
  await page.getByRole('button', { name: 'WhatsApp नहीं है? SMS से कोड पाएं' }).click();
  await page.getByText('कोड लिखें').waitFor();
  const sms = messages.sent.at(-1);
  expect(sms).toMatchObject({ channel: 'sms', to: '+919000011111' });
  expect(sms?.channel === 'sms' ? sms.text : '').toContain('मिनट');
  await page.getByLabel('कोड').fill(codeFor('+919000011111'));
  await page.getByRole('button', { name: 'साइन इन' }).click();
  await page.getByText('RECALL में आपका स्वागत है').waitFor();
  await shot(page, 'rider-welcome-hi');
  // The language is kept on the phone.
  await page.reload();
  await page.getByText('RECALL में आपका स्वागत है').waitFor();
  expect(errors).toEqual([]);
}, 120_000);
