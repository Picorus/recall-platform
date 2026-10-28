// P3.14.2: the business month by month: bookings paid, bike-hours sold, screen and moving
// bike-hours from the screens, how full the screen time was, money in, revenue, refunds.
import { fakePayments } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1, refundApproved } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { paymentMessage, sendForPayment } from '../../src/booking-desk.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { businessDashboard, businessTrends } from '../../src/dashboard.js';
import { post } from '../../src/ledger.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
const payments = fakePayments({ clock: () => NOW });

/** `hours` of screen time on 25 Aug from 10:00 India time, moving half of each minute. */
async function screenTime(screen: string, hours: number) {
  const from = Date.parse('2027-08-25T10:00:00+05:30') / 1000;
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1)', [screen]);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
     SELECT $1, g, 'minute', to_timestamp($2 + (g - 1) * 60), '{}'::jsonb
       FROM generate_series(1, $3) g`,
    [screen, from, hours * 60],
  );
  await pool.query(
    `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
       distance_m, plays, people, seconds_at, clock_at)
     SELECT $1, to_timestamp($2 + (g - 1) * 60), g, 60, 60, 30, 200, 0, 0, '{}', '{}'
       FROM generate_series(1, $3) g`,
    [screen, from, hours * 60],
  );
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  // 60 bike-hours sold for 27 Aug (₹18,000 + GST), paid now.
  await createBooking(
    pool,
    {
      bookingId: 'BK-DB-1',
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
  const link = await sendForPayment(pool, payments, 'BK-DB-1', 'Sana', NOW);
  const msg = payments.pay(link.linkId);
  await paymentMessage(pool, payments, msg.body, msg.signature, NOW + 60);
  // A draft never paid: not sold.
  await createBooking(
    pool,
    {
      bookingId: 'BK-DB-2',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: '2027-08-28', startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date: '2027-08-28', startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    NOW,
  );
  // ₹12,000 earned as plays were delivered, then a ₹500 refund approved.
  await post(
    pool,
    {
      entryId: 'test-earned-BK-DB-1',
      at: NOW + 4 * 86_400,
      kind: 'line-earned',
      ref: 'BK-DB-1/hyd-madhapur/2027-08-27/19',
      memo: 'test',
      postings: [
        { account: 'campaign-held', debit: 1_200_000, credit: 0, party: 'chai-co' },
        { account: 'revenue', debit: 0, credit: 1_200_000 },
      ],
    },
    'test',
  );
  await post(
    pool,
    refundApproved({
      refundId: 'BK-DB-1/hyd-madhapur/2027-08-27/20#refund',
      lineId: 'BK-DB-1/hyd-madhapur/2027-08-27/20',
      brandId: 'chai-co',
      base: 50_000,
      gst: 9_000,
      at: NOW + 5 * 86_400,
    }),
    'prateek',
  );
  // Two screens out 10 hours each on 25 Aug.
  await screenTime('SCR-D1', 10);
  await screenTime('SCR-D2', 10);
}, 60_000);
afterAll(async () => db.drop());

describe('the business dashboard (P3.14.2)', () => {
  it('month by month, oldest first; empty months are zero', async () => {
    // On 26 Aug: the 27 Aug campaign is still ahead, so nothing sold is over yet.
    const early = await businessDashboard(pool, '2027-08', Date.UTC(2027, 7, 26, 6) / 1000, 1);
    expect(early[0]).toMatchObject({ soldBikeHours: 60, screenBikeHours: 20, fillBp: 0 });
    const months = await businessDashboard(pool, '2027-09', Date.UTC(2027, 9, 1) / 1000, 3);
    expect(months.map((m) => m.month)).toEqual(['2027-07', '2027-08', '2027-09']);
    expect(months[1]).toEqual({
      month: '2027-08',
      bookingsPaid: 1,
      soldBikeHours: 60,
      screenBikeHours: 20,
      movingBikeHours: 10,
      fillBp: 30_000, // 60 sold of 20 screen hours here (the test's screens ran only one day)
      moneyInPaise: 2_124_000,
      revenuePaise: 1_200_000,
      refunds: 1,
      refundsPaise: 50_000,
      refundsBp: 416,
    });
    expect(months[0]).toMatchObject({ soldBikeHours: 0, fillBp: null, refundsBp: null });
    await expect(businessDashboard(pool, '2027-13', NOW)).rejects.toThrow('YYYY-MM');
    expect(await businessDashboard(pool, '2027-09', NOW, 99)).toHaveLength(24);
  });
});

/** A play stored as the screen sent it, at an India time ("2027-08-25T19:10"). */
async function play(screen: string, seq: number, india: string, slot = 'brand') {
  const at = Date.parse(`${india}:00+05:30`) / 1000;
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
     VALUES ($1, $2, 'play', to_timestamp($3), '{}'::jsonb)`,
    [screen, seq, at],
  );
  await pool.query(
    `INSERT INTO plays (screen_id, seq, start_at, key_id, slot, ref, ad_id, length_s, lat_e6,
       lng_e6, accuracy_m, screen_place, cloud_place, counts, line_id, reason, people)
     VALUES ($1, $2, to_timestamp($3), 'k1', $4, 'x', 'ad-1', 15, 17448000, 78395000, 8, 'x', 'x',
       'no', NULL, 'test', 0)`,
    [screen, seq, at, slot],
  );
}

describe('the dashboard charts (P7.7.7)', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO screen_keys (screen_id, key_id, public_key, added_by)
       VALUES ('SCR-D1', 'k1', 'AAAA', 'test')`,
    );
    await play('SCR-D1', 10_001, '2027-08-25T19:10');
    await play('SCR-D1', 10_002, '2027-08-25T19:40');
    await play('SCR-D1', 10_003, '2027-08-25T19:50', 'recall'); // our own ad: not a brand play
    await play('SCR-D1', 10_004, '2027-08-26T01:30'); // 1:30am: still the 25th (hard rule 5)
    await play('SCR-D1', 10_005, '2027-08-26T09:00'); // the next day
  });

  it('today hour by hour, 8am to 2am India time: brand plays and screens on', async () => {
    const now = Date.parse('2027-08-26T01:45:00+05:30') / 1000;
    const t = await businessTrends(pool, now, 3);
    expect(t.day).toBe('2027-08-25');
    expect(t.hours.map((h) => h.hour)).toEqual(Array.from({ length: 18 }, (_, i) => 8 + i));
    expect(t.hours[0]?.at).toBe(Date.parse('2027-08-25T08:00:00+05:30') / 1000);
    const at = (hour: number) => t.hours.find((h) => h.hour === hour);
    expect(at(19)).toMatchObject({ plays: 2, screens: 2 });
    expect(at(25)).toMatchObject({ plays: 1, screens: 0 });
    expect(at(9)).toMatchObject({ plays: 0, screens: 0 });
    expect(at(10)).toMatchObject({ plays: 0, screens: 2 });
    expect(at(20)).toMatchObject({ screens: 0 });
    expect(t.hours.reduce((n, h) => n + h.plays, 0)).toBe(3);
  });

  it('the last days by business day, oldest first, with empty days as 0', async () => {
    const now = Date.parse('2027-08-26T01:45:00+05:30') / 1000;
    const t = await businessTrends(pool, now, 3);
    expect(t.days).toEqual([
      // Paid on the 23rd at 10:01 India time, with GST.
      { day: '2027-08-23', plays: 0, screenBikeHours: 0, moneyInPaise: 2_124_000, revenuePaise: 0 },
      { day: '2027-08-24', plays: 0, screenBikeHours: 0, moneyInPaise: 0, revenuePaise: 0 },
      { day: '2027-08-25', plays: 3, screenBikeHours: 20, moneyInPaise: 0, revenuePaise: 0 },
    ]);
    // Revenue earned on the 27th; the next morning's play is the 26th's.
    const later = await businessTrends(pool, Date.parse('2027-08-27T12:00:00+05:30') / 1000, 2);
    expect(later.days).toEqual([
      { day: '2027-08-26', plays: 1, screenBikeHours: 0, moneyInPaise: 0, revenuePaise: 0 },
      { day: '2027-08-27', plays: 0, screenBikeHours: 0, moneyInPaise: 0, revenuePaise: 1_200_000 },
    ]);
    expect((await businessTrends(pool, now, 500)).days).toHaveLength(90);
    expect((await businessTrends(pool, now, 0)).days).toHaveLength(1);
  });
});
