// P5.4: booking on the portal: the form (areas on, hours with their bands, picks, limits, earliest
// start); a live price for a plan, with what stops it in the brand's words (under the minimum, too
// soon, hours sold); saving it as a draft of the business that holds no bikes; "book again".
import { launchAreas, PRICE_BOOK_V1, type PortalPlan } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { bookForm, bookFromPortal, planFrom, portalQuote } from '../../src/brand-booking.js';
import { portalCampaigns } from '../../src/brand-campaigns.js';
import { savePriceBook, setAreaHourLimit } from '../../src/bookings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Mon 23 Aug 2027, 10:00 India: the earliest portal start is Wed 8 Sep.
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;

const plan: PortalPlan = {
  areaIds: ['hyd-madhapur'],
  hours: [19, 20],
  weekdays: [5, 6],
  startDate: '2027-09-08',
  weeks: 2,
  bikes: 20,
  repeatMonths: 1,
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
}, 120_000);
afterAll(async () => db.drop());

describe('book (P5.4)', () => {
  it('the form: areas with their shapes, hours with their bands and prices, picks, limits', async () => {
    const f = await bookForm(pool, NOW);
    expect(f.areas.length).toBeGreaterThan(5);
    expect(f.areas.find((a) => a.areaId === 'hyd-madhapur')?.ring.length).toBeGreaterThan(3);
    expect(f.hours.find((h) => h.hour === 19)).toEqual({
      hour: 19,
      label: '7 pm',
      band: 'Peak',
      paisePerBikeHour: 30_000,
    });
    expect(f.picks.map((p) => p.label)).toContain('Evening rush');
    expect(f).toMatchObject({
      earliestStart: '2027-09-08',
      minBikes: 5,
      maxBikes: 100,
      minBookingPaise: 1_500_000,
    });
  });

  it('a live price: bike-hours, plays, GST, total; the deal discount; under the minimum told', async () => {
    const q = await portalQuote(pool, plan, NOW);
    // 2 weeks × Fri, Sat × 2 hours × 20 bikes = 160 bike-hours at ₹300.
    expect(q).toEqual({
      price: {
        lines: 8,
        days: 4,
        bikeHours: 160,
        plays: 32_000,
        listPaise: 4_800_000,
        discountPaise: 0,
        subtotalPaise: 4_800_000,
        gstPaise: 864_000,
        totalPaise: 5_664_000,
        firstDay: '2027-09-10',
        lastDay: '2027-09-18',
      },
      problems: [],
    });
    const deal = await portalQuote(pool, { ...plan, repeatMonths: 6, weeks: 1 }, NOW);
    expect(deal.price?.discountPaise).toBe(Math.round((deal.price?.listPaise ?? 0) * 0.08));
    const small = await portalQuote(pool, { ...plan, weeks: 1, bikes: 5, hours: [19] }, NOW);
    expect(small.price?.subtotalPaise).toBe(300_000);
    expect(small.problems).toEqual([
      'The smallest booking is ₹15,000 before GST: add hours, days or bikes',
    ]);
    const soon = await portalQuote(pool, { ...plan, startDate: '2027-08-30' }, NOW);
    expect(soon.price).not.toBeNull();
    expect(soon.problems[0]).toMatch(/^Campaigns booked here start on or after Wed 8 Sep/);
    expect((await portalQuote(pool, { ...plan, areaIds: ['made-up'] }, NOW)).problems).toEqual([
      'Pick your areas from the map',
    ]);
    expect((await portalQuote(pool, { ...plan, bikes: 500 }, NOW)).problems).toEqual([
      'From 5 to 100 bikes each hour',
    ]);
  });

  it('hours already sold are named; a plan is saved as a draft holding no bikes; book again', async () => {
    await setAreaHourLimit(
      pool,
      { areaId: 'hyd-madhapur', date: '2027-09-10', startHour: 19 },
      12,
      'prateek',
      'POC fleet',
    );
    const q = await portalQuote(pool, plan, NOW);
    expect(q.problems).toEqual([
      expect.stringMatching(/Madhapur.*, Fri 10 Sep, 7 pm: 12 bikes left$/),
    ]);
    await expect(
      bookFromPortal(pool, { brandId: 'chai-co', plan, by: 'portal:+919848011111' }, NOW),
    ).rejects.toThrow(/Some of these hours are sold: .*12 bikes left/);
    const id = await bookFromPortal(
      pool,
      { brandId: 'chai-co', plan: { ...plan, bikes: 10 }, by: 'portal:+919848011111' },
      NOW,
    );
    expect(id).toMatch(/^BK-[0-9A-F]{10}$/);
    expect(
      (await portalCampaigns(pool, 'chai-co', NOW)).map((c) => [c.bookingId, c.stage, c.bikeHours]),
    ).toEqual([[id, 'to-pay', 80]]);
    // A draft holds nothing: the same 12 bikes are still free for someone else.
    const other = await portalQuote(pool, { ...plan, bikes: 12, weeks: 1, weekdays: [5] }, NOW);
    expect(other.problems.filter((p) => p.includes('left'))).toEqual([]);
    expect(await planFrom(pool, 'chai-co', id, NOW)).toEqual({
      ...plan,
      bikes: 10,
      startDate: '2027-09-08',
    });
    expect(await planFrom(pool, 'dosa-co', id, NOW)).toBeUndefined();
  });
});
