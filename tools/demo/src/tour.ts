// A walk through every app of a running demo (pnpm demo) in a real browser, signing in as a person
// would (codes read from the demo desk), with a picture of each page for the guides in docs/guides.
// It also proves the demo works end to end.
//   pnpm --filter @recall/demo tour            (pictures to docs/guides/img)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { BRAND_PHONE, riderOf, STAFF } from './world.js';

const ROOT = join(import.meta.dirname, '../../..');
const OUT = process.env.TOUR_DIR ?? join(ROOT, 'docs', 'guides', 'img');
const DESK = 'http://localhost:4000';
const STAFF_SITE = 'http://localhost:3001';
const BRAND_SITE = 'http://localhost:3000';
const RIDER_SITE = 'http://localhost:8081';
mkdirSync(OUT, { recursive: true });

const problems: string[] = [];
async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ${name}`);
}
/** The newest code shown on the demo desk for this number or email (or the staff code). */
async function deskCode(page: Page, to?: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const html = await (await fetch(DESK)).text();
    const m = to
      ? new RegExp(`${to.replace(/[+.]/g, '\\$&')}</td><td[^>]*>(\\d{6})<`).exec(html)
      : /class="big mono">(\d{6})</.exec(html);
    if (m?.[1]) return m[1];
    await page.waitForTimeout(500);
  }
  throw new Error(`no code on the desk for ${to ?? 'staff'}`);
}
async function visit(page: Page, url: string, name: string) {
  const res = await page.goto(url);
  if (!res?.ok()) problems.push(`${name}: ${res?.status()}`);
  await shot(page, name);
}

const browser = await chromium.launch();
try {
  // The demo desk.
  const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await visit(desk, DESK, 'desk');

  // Staff portal: sign in as the founder, then every page.
  console.log('staff portal');
  const staff = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await visit(staff, `${STAFF_SITE}/sign-in`, 'staff-sign-in');
  await staff.getByLabel('Email').fill(STAFF[0]?.email ?? '');
  await staff.getByLabel('Password').fill('recall demo 2027');
  await staff.getByLabel('Code from your authenticator app').fill(await deskCode(staff));
  await staff.getByRole('button', { name: 'Sign in' }).click();
  await staff.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });
  for (const p of [
    'dashboard',
    'calendar',
    'brands',
    'reviews',
    'delivery',
    'reports',
    'fleet',
    'screens',
    'riders',
    'payouts',
    'money',
    'support',
    'areas',
    'prices',
    'settings',
    'staff',
    'audit',
  ])
    await visit(staff, `${STAFF_SITE}/${p}`, `staff-${p}`);
  await visit(staff, `${STAFF_SITE}/`, 'staff-today');

  // Brand portal: the owner of Masala Chai Co, by WhatsApp code.
  console.log('brand portal');
  const brand = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await visit(brand, `${BRAND_SITE}/sign-in`, 'brand-sign-in');
  await brand.getByLabel('Mobile number').fill(BRAND_PHONE.slice(3));
  await brand.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await brand.getByLabel('Code').fill(await deskCode(brand, BRAND_PHONE));
  await brand.getByRole('button', { name: 'Sign in' }).click();
  await brand.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 15_000 });
  await shot(brand, 'brand-campaigns');
  const q = 'brand=masala-chai-co';
  for (const [p, name] of [
    [`/book?${q}`, 'brand-book'],
    [`/ads?${q}`, 'brand-ads'],
    [`/invoices?${q}`, 'brand-invoices'],
    [`/help?${q}`, 'brand-help'],
    [`/team?${q}`, 'brand-team'],
    [`/business?${q}`, 'brand-business'],
    ['/campaigns/BK-DEMO-0001/report', 'brand-report'],
  ] as const)
    await visit(brand, `${BRAND_SITE}${p}`, name);

  // Rider app (phone size): a rider by WhatsApp code.
  console.log('rider app');
  const rider = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const r = riderOf(0);
  await visit(rider, RIDER_SITE, 'rider-welcome');
  await rider.getByLabel('Mobile number').fill(r.phone.slice(3));
  await rider.getByRole('button', { name: 'Send code on WhatsApp' }).click();
  await rider.getByLabel('Code').fill(await deskCode(rider, r.phone));
  await rider.getByRole('button', { name: 'Sign in' }).click();
  await rider.waitForTimeout(3000);
  await shot(rider, 'rider-home');
} finally {
  await browser.close();
}
if (problems.length > 0) {
  console.error(`Pages that did not open:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else console.log(`All pages opened. Pictures in ${OUT}`);
