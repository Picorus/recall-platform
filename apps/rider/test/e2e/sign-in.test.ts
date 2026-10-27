// The rider app (web build) in a real browser against the real API and a real database (P4.1):
// language, a wrong number, a code on WhatsApp, a wrong code, signed in as a known rider, still
// signed in after a reload, signed out; a new number by SMS in Hindi is welcomed to the sign-up.
// Needs `pnpm test:e2e` (it builds the app for the web first) and DATABASE_URL (pnpm services:up).
import { fakeBankCheck, fakeEsign, fakeFileStore, fakeKyc, fakeMessages } from '@recall/adapters';
import { apiHandler } from '@recall/api';
import { createRider, reviewRiderDocument } from '@recall/db';
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
        files: fakeFileStore({ baseUrl: 'http://127.0.0.1/files', secret: 'e2e' }),
        riderChecks: {
          kyc: fakeKyc({ auto: true }),
          esign: fakeEsign({ auto: true }),
          bank: fakeBankCheck(),
        },
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
  // His application is open: the joining steps.
  await page.getByText('Join RECALL').waitFor();
  await page.getByText('0 of 6 done. You can stop and come back any time.').waitFor();
  // Still signed in after the app is opened again.
  await page.reload();
  await page.getByText('Join RECALL').waitFor();
  // No signal when the app opens: still signed in, "Try again" (never a new code).
  await page.route('**/rider/me', (r) => r.abort());
  await page.reload();
  await page
    .getByRole('alert')
    .getByText('No internet. Check your connection and try again.')
    .waitFor();
  await page.unroute('**/rider/me');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Join RECALL').waitFor();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByText('Earn while you ride.').waitFor();
  await page.reload();
  await page.getByText('Earn while you ride.').waitFor();
  expect(errors).toEqual([]);
}, 120_000);

it('a new number by SMS, in Hindi: the sign-up opens', async () => {
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
  await page.getByText('मेरा साइन-अप शुरू करें').waitFor();
  await shot(page, 'rider-sign-up-hi');
  // The language is kept on the phone.
  await page.reload();
  await page.getByText('मेरा साइन-अप शुरू करें').waitFor();
  expect(errors).toEqual([]);
}, 120_000);

const PNG = new URL(
  '../../../../packages/domain/test/fixtures/ads/ad-1280x640.png',
  import.meta.url,
).pathname;

it('a new rider signs up and goes through every step to the screen loan', async () => {
  const { page, errors } = await phonePage();
  const phone = '+919700012345';
  await page.getByLabel('Mobile number').fill('97000 12345');
  await page.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await page.getByText('Type the code').waitFor();
  await page.getByLabel('Code').fill(codeFor(phone));
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Sign up: name, where he rides, his apps.
  await page.getByRole('button', { name: 'Start my sign-up' }).click();
  await page.getByRole('alert').getByText('Type your name (2 to 80 letters).').waitFor();
  await page.getByLabel('Your name (as on your Aadhaar)').fill('Kiran Goud');
  await page.getByLabel('Where you ride most').fill('Gachibowli');
  await page.getByRole('checkbox', { name: 'Swiggy' }).click();
  await page.getByRole('checkbox', { name: 'Zepto' }).click();
  await page.getByRole('button', { name: 'Start my sign-up' }).click();
  await page.getByText('Join RECALL').waitFor();
  await shot(page, 'rider-join');
  const riderId = String(
    (
      await db.pool.query<{ rider_id: string }>(
        'SELECT rider_id FROM rider_versions WHERE phone = $1',
        [phone],
      )
    ).rows[0]?.rider_id,
  );
  const sendPicture = async (doc: string) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByLabel(doc).getByRole('button', { name: 'Choose a photo' }).click();
    await (await chooser).setFiles(PNG);
    await page.getByLabel(doc).getByText('We are checking it').waitFor();
  };
  // 1. Profile: his photo.
  await page.getByRole('button', { name: /^Profile: To do/ }).click();
  await sendPicture('Your photo');
  await page.getByRole('button', { name: '‹ Back' }).click();
  // 2. Vehicle: plate, RC and insurance.
  await page.getByRole('button', { name: /^Vehicle papers: To do/ }).click();
  await page.getByLabel('Number plate').fill('ts 09 ab 4321');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Saved.').waitFor();
  await sendPicture('Registration (RC)');
  await sendPicture('Insurance');
  await shot(page, 'rider-vehicle');
  await page.getByRole('button', { name: '‹ Back' }).click();
  await page.getByRole('button', { name: /^Vehicle papers: Checking/ }).waitFor();
  // Operations look at them (the admin portal; here straight in the database).
  const docs = await db.pool.query<{ doc_id: string; kind: string }>(
    'SELECT doc_id, kind FROM rider_documents WHERE rider_id = $1',
    [riderId],
  );
  for (const d of docs.rows)
    await reviewRiderDocument(
      db.pool,
      {
        riderId,
        docId: d.doc_id,
        decision: 'accepted',
        reason: 'clear photo',
        expiresOn: d.kind === 'insurance' ? '2030-01-01' : null,
        by: 'Omar',
      },
      Math.floor(Date.now() / 1000),
    );
  // 3. ID check: the provider's page opens; back here, he says he has finished.
  await page.reload();
  await page.getByRole('button', { name: /^ID check: To do/ }).click();
  const popup = page.waitForEvent('popup').catch(() => undefined);
  await page.getByRole('button', { name: 'Check my ID' }).click();
  await (await popup)?.close();
  await page.getByRole('button', { name: 'I have finished' }).click();
  await page.getByText('Your ID is checked.').waitFor();
  await page.getByRole('button', { name: '‹ Back' }).click();
  // 4. Bank or UPI: a ₹1 check in his name.
  await page.getByRole('button', { name: /^Bank or UPI: To do/ }).click();
  await page.getByLabel('UPI id').fill('kiran@okaxis');
  await page.getByRole('button', { name: 'Check with ₹1' }).click();
  await page.getByText('Checked. Your pay goes to this account.').waitFor();
  await page.getByRole('button', { name: '‹ Back' }).click();
  // 5. The agreement, with the camera line.
  await page.getByRole('button', { name: /^Rider agreement: To do/ }).click();
  await page.getByText('"This screen counts people. It records nothing."').first().waitFor();
  const sign = page.waitForEvent('popup').catch(() => undefined);
  await page.getByRole('button', { name: 'Read and sign' }).click();
  await (await sign)?.close();
  await page.getByRole('button', { name: 'I have signed' }).click();
  await page.getByText('Signed.').waitFor();
  await page.getByRole('button', { name: '‹ Back' }).click();
  // Five of six done; the screen loan comes next (the bank's form, when the bank is set up).
  await page.getByText('5 of 6 done. You can stop and come back any time.').waitFor();
  await page.getByRole('button', { name: /^Screen loan: To do/ }).click();
  await page.getByText(/bought with a loan from Dhanlaxmi Bank/).waitFor();
  await page.getByRole('button', { name: '‹ Back' }).click();
  await shot(page, 'rider-join-done');
  expect(errors).toEqual([]);
}, 180_000);
