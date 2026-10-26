// P3.13.1: money routes: finance looks (a read-only finance member too); others do not; a month's
// payments, invoices and GST summary; the accountant's files.
import { fakePayments } from '@recall/adapters';
import {
  createBooking,
  paymentMessage,
  post,
  saveAreaVersion,
  savePriceBook,
  sendForPayment,
} from '@recall/db';
import { freshDatabase } from '@recall/db/test-db';
import { launchAreas, moneyToReturn, PRICE_BOOK_V1, refundApproved } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';
import { members } from './members.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: ['https://admin.test'],
  secureCookies: true,
  proxyHops: 0,
};
const member = members(() => pool, NOW * 1000);
const payments = fakePayments({ clock: () => NOW });

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createBooking(
    pool,
    {
      bookingId: 'BK-MY-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    NOW,
  );
  const link = await sendForPayment(pool, payments, 'BK-MY-1', 'Sana', NOW);
  const msg = payments.pay(link.linkId);
  await paymentMessage(pool, payments, msg.body, msg.signature, NOW + 60);
  // Owed back: a refund on that booking, and a payment for a link we never knew.
  await post(
    pool,
    refundApproved({
      refundId: 'BK-MY-1/hyd-madhapur/2027-08-27/19#refund',
      lineId: 'BK-MY-1/hyd-madhapur/2027-08-27/19',
      brandId: 'chai-co',
      base: 500_000,
      gst: 90_000,
      at: NOW + 90,
    }),
    'prateek',
  );
  await post(
    pool,
    moneyToReturn({
      paymentId: 'pay_stray',
      ref: 'lnk_stray',
      amount: 100_000,
      why: 'x',
      at: NOW + 95,
    }),
    'payments',
  );
  server = createServer(
    apiHandler(
      pool,
      { ...CFG, payments },
      () => {},
      () => NOW * 1000 + 120_000,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

describe('money routes (P3.13.1)', () => {
  it('finance looks at a month; others do not; the accountant files', async () => {
    const ops = await member('omar@recall.in', { role: 'admin', areas: ['operations'] });
    const fin = await member('lata@recall.in', { role: 'read-only', areas: ['finance'] });
    const get = (cookie: string, path: string) => fetch(`${url}${path}`, { headers: { cookie } });

    expect((await get(ops, '/money')).status).toBe(403);
    expect((await get(fin, '/money?month=2027-13')).status).toBe(400);
    const m = (await (await get(fin, '/money')).json()) as {
      month: string;
      payments: { bookingId: string; state: string }[];
      documents: { kind: string; totalPaise: number }[];
      gst: { invoices: { count: number } };
      position: { heldForCampaignsPaise: number };
    };
    expect(m.month).toBe('2027-08');
    expect(m.payments.map((p) => [p.bookingId, p.state])).toEqual([['BK-MY-1', 'paid']]);
    expect(m.documents).toMatchObject([{ kind: 'invoice', totalPaise: 2_124_000 }]);
    expect(m.gst.invoices.count).toBe(1);
    expect(m.position.heldForCampaignsPaise).toBe(1_300_000); // ₹18,000 paid less the ₹5,000 refund
    const july = (await (await get(fin, '/money?month=2027-07')).json()) as { payments: [] };
    expect(july.payments).toEqual([]);

    const ex = (await (await get(fin, '/money/export?month=2027-08')).json()) as {
      files: { name: string; csv: string }[];
    };
    expect(ex.files.map((f) => f.name)).toEqual([
      'invoices-2027-08.csv',
      'credit-notes-2027-08.csv',
      'partner-invoices-2027-08.csv',
      'journal-2027-08.csv',
      'gst-summary-2027-08.csv',
    ]);
    expect(ex.files[0]?.csv).toContain('BK-MY-1');
    expect(
      (
        await fetch(`${url}/money`, {
          method: 'POST',
          headers: { cookie: fin, origin: 'https://admin.test' },
        })
      ).status,
    ).toBe(405);
    expect((await get(fin, '/money/other')).status).toBe(404);
  });

  it('money owed back: finance admins send it or record a bank transfer; others only look', async () => {
    const look = await member('lata2@recall.in', { role: 'read-only', areas: ['finance'] });
    const fin = await member('farah@recall.in', { role: 'admin', areas: ['finance'] });
    const post2 = (cookie: string, path: string, body: object) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { cookie, origin: 'https://admin.test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const list = (await (
      await fetch(`${url}/money/owed-back`, { headers: { cookie: look } })
    ).json()) as { items: { owedEntry: string; state: string }[]; canPay: boolean };
    expect(list.canPay).toBe(false);
    expect(list.items.map((i) => i.owedEntry)).toEqual([
      'refund:BK-MY-1/hyd-madhapur/2027-08-27/19#refund',
      'to-return:pay_stray',
    ]);
    const refund = { owedEntry: 'refund:BK-MY-1/hyd-madhapur/2027-08-27/19#refund' };
    expect((await post2(look, '/money/owed-back/send', refund)).status).toBe(403);
    expect((await post2(fin, '/money/owed-back/send', { owedEntry: 'drop table' })).status).toBe(
      400,
    );
    expect(
      (await post2(fin, '/money/owed-back/send', { owedEntry: 'refund:BK-NONE#refund' })).status,
    ).toBe(404);
    expect(await (await post2(fin, '/money/owed-back/send', refund)).json()).toEqual({
      ...refund,
      state: 'refunded',
    });
    expect((await post2(fin, '/money/owed-back/send', refund)).status).toBe(409);
    const stray = { owedEntry: 'to-return:pay_stray' };
    expect(
      (await post2(fin, '/money/owed-back/by-hand', { ...stray, reference: '!' })).status,
    ).toBe(400);
    expect(
      (await post2(fin, '/money/owed-back/by-hand', { ...stray, reference: 'UTR20270823001' }))
        .status,
    ).toBe(200);
    const after = (await (
      await fetch(`${url}/money/owed-back`, { headers: { cookie: fin } })
    ).json()) as { items: []; canPay: boolean };
    expect(after).toMatchObject({ items: [], canPay: true });
  });
});
