// P3.14.1: report routes: Sales, Support and Finance look at ended campaigns and open a report (its
// page and PDF); Sales and Support admins send it again (once per press); nothing is sent without
// messages set up.
import { fakeMaps, fakeMessages } from '@recall/adapters';
import {
  createBooking,
  moveBooking,
  saveAreaVersion,
  savePriceBook,
  setBrandContact,
} from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, lineStartsAt, PRICE_BOOK_V1, type CampaignReport } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';
import { members } from './members.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const servers: Server[] = [];
let url = '';
let bare = '';
const DAY = '2027-09-30';
const ENDS = lineStartsAt({ date: DAY, startHour: 20 }) + 3600;
const NOW = ENDS + 3 * 86_400;
const ORIGIN = 'https://admin.test';
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: [ORIGIN],
  secureCookies: true,
  proxyHops: 0,
};
const messages = fakeMessages();
const member = members(() => pool, NOW * 1000);
const REPORT: CampaignReport = {
  bookingId: 'BK-RP-1',
  brandId: 'chai-co',
  from: ENDS - 7200,
  until: ENDS,
  builtAt: ENDS + 48 * 3600,
  lines: [],
  promised: 6_000,
  delivered: 5_400,
  deliveredBp: 9_000,
  missing: 600,
  bikes: 28,
  makeUps: { opened: 0, plays: 0 },
  refund: undefined,
  heatMap: [],
  streets: [],
  people: { low: 20_000, high: 28_000, approximate: true, text: '20,000–28,000 (approximate)' },
};

const listen = async (cfg: StaffApiConfig) => {
  const s = createServer(
    apiHandler(
      pool,
      cfg,
      () => {},
      () => NOW * 1000,
    ),
  );
  servers.push(s);
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  const booked = Date.UTC(2027, 7, 1) / 1000;
  await createBooking(
    pool,
    {
      bookingId: 'BK-RP-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: DAY, startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date: DAY, startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    booked,
  );
  const who = { by: 'Sana', actor: 'admin' } as const;
  const sys = { by: 'system', actor: 'system' } as const;
  await moveBooking(pool, 'BK-RP-1', 'awaiting-payment', who, booked);
  await moveBooking(pool, 'BK-RP-1', 'paid', sys, booked + 60);
  await moveBooking(pool, 'BK-RP-1', 'ads-approved', who, booked + 120);
  await moveBooking(pool, 'BK-RP-1', 'running', sys, ENDS - 7200);
  await moveBooking(pool, 'BK-RP-1', 'done', sys, ENDS);
  await pool.query(
    `INSERT INTO campaign_reports (booking_id, built_at, report) VALUES ($1, to_timestamp($2), $3)`,
    ['BK-RP-1', REPORT.builtAt, JSON.stringify(REPORT)],
  );
  await setBrandContact(pool, 'chai-co', { email: 'chai@example.in' }, 'Sana');
  url = await listen({
    ...CFG,
    reports: { maps: fakeMaps(), messages, portalUrl: 'https://brand.test' },
  });
  bare = await listen(CFG);
}, 120_000);
afterAll(async () => {
  for (const s of servers) await new Promise<void>((ok) => s.close(() => ok()));
  await db.drop();
});

describe('report routes (P3.14.1)', () => {
  it('who looks and opens a report; who sends it again; once per press', async () => {
    const ops = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const look = await member('lata@recall.in', { role: 'read-only', areas: ['sales'] });
    const sales = await member('sana@recall.in', { role: 'admin', areas: ['sales'] });
    const get = (cookie: string, path: string, at = url) =>
      fetch(`${at}${path}`, { headers: { cookie } });
    const post = (cookie: string, path: string, body: object, at = url) =>
      fetch(`${at}${path}`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    expect((await get(ops, '/reports')).status).toBe(403);
    const list = (await (await get(look, '/reports')).json()) as {
      rows: { bookingId: string; stage: string; deliveredBp: number }[];
      canResend: boolean;
    };
    expect(list.canResend).toBe(false);
    expect(list.rows).toMatchObject([
      { bookingId: 'BK-RP-1', stage: 'sending', deliveredBp: 9_000 },
    ]);
    const page = (await (await get(look, '/reports/BK-RP-1/page')).json()) as { html: string };
    expect(page.html).toContain('BK-RP-1');
    const pdf = (await (await get(look, '/reports/BK-RP-1/pdf')).json()) as {
      name: string;
      base64: string;
    };
    expect(pdf.name).toBe('RECALL-report-BK-RP-1.pdf');
    expect(Buffer.from(pdf.base64, 'base64').subarray(0, 4).toString()).toBe('%PDF');
    expect((await get(look, '/reports/BK-NONE/page')).status).toBe(404);

    expect((await post(look, '/reports/BK-RP-1/resend', { channel: 'email' })).status).toBe(403);
    expect((await post(sales, '/reports/BK-RP-1/resend', { channel: 'fax' })).status).toBe(400);
    expect((await post(sales, '/reports/BK-RP-1/resend', { channel: 'email' }, bare)).status).toBe(
      503,
    );
    expect(
      await (await post(sales, '/reports/BK-RP-1/resend', { channel: 'email' })).json(),
    ).toEqual({ channel: 'email', status: 'sent' });
    expect(messages.sent.map((m) => [m.to, m.key])).toEqual([
      ['chai@example.in', 'report-resend:BK-RP-1:email:1'],
    ]);
    expect((await post(sales, '/reports/BK-RP-1/resend', { channel: 'email' })).status).toBe(409);
    // No WhatsApp number on record.
    expect((await post(sales, '/reports/BK-RP-1/resend', { channel: 'whatsapp' })).status).toBe(
      400,
    );
    const after = (await (await get(sales, '/reports')).json()) as {
      rows: { stage: string; sends: { email?: { status: string } } }[];
      canResend: boolean;
    };
    expect(after).toMatchObject({
      canResend: true,
      rows: [{ stage: 'sent', sends: { email: { status: 'sent' } } }],
    });
  });
});
