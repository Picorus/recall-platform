// P5.3: a business's campaigns on the portal: its bookings only, newest first, with areas, days,
// bike-hours, plays promised and total; To pay, Scheduled, Running, Done or Cancelled by the step
// and the hours, with what comes next; a draft staff are still writing is not shown.
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { portalCampaigns } from '../../src/brand-campaigns.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;

const book = (bookingId: string, brandId: string, date: string, channel: 'admin' | 'portal') =>
  createBooking(
    pool,
    {
      bookingId,
      brandId,
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date, startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date, startHour: 20, bikes: 30 },
          { areaId: 'hyd-gachibowli', date, startHour: 19, bikes: 20 },
        ],
        repeatMonths: 1,
        channel,
      },
      by: 'Sana',
    },
    NOW,
  );
/** A step as the payment and the scheduler would write it (test only). */
const step = (bookingId: string, state: string) =>
  pool.query(
    `INSERT INTO booking_events (booking_id, seq, state, at, by_who)
     SELECT $1, max(seq) + 1, $2, to_timestamp($3), 'system' FROM booking_events WHERE booking_id = $1`,
    [bookingId, state, NOW],
  );

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await book('BK-C-DRAFT', 'chai-co', '2027-09-20', 'admin');
  await book('BK-C-TOPAY', 'chai-co', '2027-09-15', 'admin');
  await moveBooking(pool, 'BK-C-TOPAY', 'awaiting-payment', { by: 'Sana', actor: 'admin' }, NOW);
  await book('BK-C-PAID', 'chai-co', '2027-09-10', 'admin');
  await step('BK-C-PAID', 'awaiting-payment');
  await step('BK-C-PAID', 'paid');
  await book('BK-C-OTHER', 'dosa-co', '2027-09-10', 'admin');
  await step('BK-C-OTHER', 'awaiting-payment');
}, 120_000);
afterAll(async () => db.drop());

describe('my campaigns (P5.3)', () => {
  it('its own bookings, newest first, with their parts; a staff draft is not shown', async () => {
    const list = await portalCampaigns(pool, 'chai-co', NOW);
    expect(list.map((x) => [x.bookingId, x.stage])).toEqual([
      ['BK-C-TOPAY', 'to-pay'],
      ['BK-C-PAID', 'scheduled'],
    ]);
    expect(list[1]).toMatchObject({
      note: 'Add your ads',
      areas: ['Gachibowli', 'Madhapur'].map((n) => expect.stringContaining(n)),
      firstDay: '2027-09-10',
      lastDay: '2027-09-10',
      days: 1,
      bikeHours: 80,
      trial: false,
    });
    expect(list[1]?.playsPromised).toBeGreaterThan(0);
    expect(list[1]?.totalPaise).toBeGreaterThan(0);
  });

  it('running in its hours, done after them, cancelled kept', async () => {
    const paid = (await portalCampaigns(pool, 'chai-co', NOW)).find(
      (x) => x.bookingId === 'BK-C-PAID',
    );
    if (!paid) throw new Error('missing');
    const during = await portalCampaigns(pool, 'chai-co', paid.firstHourAt + 60);
    expect(during.find((x) => x.bookingId === 'BK-C-PAID')?.stage).toBe('running');
    const after = await portalCampaigns(pool, 'chai-co', paid.lastHourEndsAt + 60);
    expect(after.find((x) => x.bookingId === 'BK-C-PAID')).toMatchObject({
      stage: 'done',
      note: 'Your report is on its way',
    });
    await moveBooking(
      pool,
      'BK-C-TOPAY',
      'cancelled',
      { by: 'Sana', actor: 'admin', reason: 'brand said no' },
      NOW,
    );
    expect((await portalCampaigns(pool, 'chai-co', NOW))[0]).toMatchObject({
      bookingId: 'BK-C-TOPAY',
      stage: 'cancelled',
      note: null,
    });
    expect((await portalCampaigns(pool, 'dosa-co', NOW)).map((x) => x.bookingId)).toEqual([
      'BK-C-OTHER',
    ]);
  });
});
