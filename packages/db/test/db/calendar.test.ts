// P3.7: one area's week on the inventory calendar; holds kept, released early, and turned into a
// booking without being counted twice.
import { holdLinesOf, launchAreas, PRICE_BOOK_V1, type BookingLine } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import {
  CapacityError,
  createBooking,
  moveBooking,
  placeHold,
  savePriceBook,
  setAreaHourLimit,
} from '../../src/bookings.js';
import { calendarWeek, endHold } from '../../src/calendar.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Mon 23 Aug 2027, 10:00 India time.
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const AREA = 'hyd-madhapur';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
});
afterAll(async () => db.drop());

const cell = async (date: string, startHour: number, now = NOW) =>
  (await calendarWeek(pool, AREA, '2027-08-23', now)).cells.find(
    (c) => c.date === date && c.startHour === startHour,
  );
const line = (date: string, startHour: number, bikes: number): BookingLine => ({
  areaId: AREA,
  date,
  startHour,
  bikes,
});

describe('inventory calendar (P3.7)', () => {
  it('a week of every start hour; a paid booking shows as booked; no limit in the POC means nothing is "free" to count', async () => {
    const week = await calendarWeek(pool, AREA, '2027-08-23', NOW);
    expect(week.days).toEqual([
      '2027-08-23',
      '2027-08-24',
      '2027-08-25',
      '2027-08-26',
      '2027-08-27',
      '2027-08-28',
      '2027-08-29',
    ]);
    expect(week.cells).toHaveLength(7 * 18);
    expect(week.mode).toBe('poc');
    await createBooking(
      pool,
      {
        bookingId: 'BK-CAL-1',
        brandId: 'biryani-hub',
        request: {
          lines: [line('2027-08-27', 19, 30), line('2027-08-27', 20, 30)],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      NOW,
    );
    // A draft keeps nothing.
    expect(await cell('2027-08-27', 19)).toMatchObject({
      booked: 0,
      held: 0,
      limit: null,
      free: null,
    });
    await moveBooking(pool, 'BK-CAL-1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, NOW);
    await moveBooking(pool, 'BK-CAL-1', 'paid', { by: 'system', actor: 'system' }, NOW + 10);
    expect(await cell('2027-08-27', 19)).toEqual({
      date: '2027-08-27',
      startHour: 19,
      booked: 30,
      held: 0,
      manualLimit: null,
      limit: null,
      free: null,
      usual: null,
      deliveredTenths: null,
    });
    // After the hour, with no plays counted yet, it shows 0 delivered.
    const after = Date.UTC(2027, 7, 27, 15, 0) / 1000; // 20:30 India time
    expect((await cell('2027-08-27', 19, after))?.deliveredTenths).toBe(0);
    expect((await cell('2027-08-27', 20, after))?.deliveredTenths).toBeNull();
  });

  it('a manual limit: free = limit − booked − held; a hold that does not fit is refused', async () => {
    await setAreaHourLimit(pool, line('2027-08-27', 19, 0), 50, 'prateek', 'flyover works');
    expect(await cell('2027-08-27', 19)).toMatchObject({
      booked: 30,
      manualLimit: 50,
      limit: 50,
      free: 20,
    });
    await placeHold(
      pool,
      {
        holdId: 'HLD-CAL-1',
        brandId: 'chai-co',
        lines: holdLinesOf(AREA, ['2027-08-27'], [19], 15),
        until: NOW + 3 * 86_400,
        by: 'Sana (STF-1)',
        reason: 'call on Monday',
      },
      NOW,
    );
    expect(await cell('2027-08-27', 19)).toMatchObject({ held: 15, free: 5 });
    await expect(
      placeHold(
        pool,
        {
          holdId: 'HLD-CAL-2',
          brandId: 'dosa-co',
          lines: holdLinesOf(AREA, ['2027-08-27'], [19], 6),
          until: NOW + 86_400,
          by: 'Sana (STF-1)',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(CapacityError);
    const holds = (await calendarWeek(pool, AREA, '2027-08-23', NOW)).holds;
    expect(holds[0]).toMatchObject({
      holdId: 'HLD-CAL-1',
      brandId: 'chai-co',
      reason: 'call on Monday',
      until: NOW + 3 * 86_400,
      endedEarly: null,
      bookingId: null,
      lines: [{ date: '2027-08-27', startHour: 19, bikes: 15 }],
    });
  });

  it('released early: its bikes are free again at once; it cannot be released twice or booked from', async () => {
    await endHold(pool, 'HLD-CAL-1', 'Sana (STF-1)', 'client said no', NOW + 60);
    expect(await cell('2027-08-27', 19, NOW + 61)).toMatchObject({ held: 0, free: 20 });
    // Before the release it was still kept.
    expect(await cell('2027-08-27', 19, NOW + 59)).toMatchObject({ held: 15 });
    await expect(endHold(pool, 'HLD-CAL-1', 'Sana', 'again', NOW + 120)).rejects.toThrow(
      'already released',
    );
    await expect(endHold(pool, 'HLD-NOPE', 'Sana', 'again', NOW + 120)).rejects.toThrow('No hold');
    await expect(
      createBooking(
        pool,
        {
          bookingId: 'BK-CAL-2',
          brandId: 'chai-co',
          request: { lines: [line('2027-08-27', 19, 15)], repeatMonths: 1, channel: 'admin' },
          by: 'sana',
          holdId: 'HLD-CAL-1',
        },
        NOW + 120,
      ),
    ).rejects.toThrow('This hold has ended');
    const h = (await calendarWeek(pool, AREA, '2027-08-23', NOW + 120)).holds[0];
    expect(h).toMatchObject({
      until: NOW + 60,
      endedEarly: { at: NOW + 60, by: 'Sana (STF-1)', reason: 'client said no' },
    });
    await expect(pool.query('DELETE FROM hold_ends')).rejects.toThrow();
  });

  it('a hold turned into a booking is counted once, as the booking', async () => {
    await placeHold(
      pool,
      {
        holdId: 'HLD-CAL-3',
        brandId: 'chai-co',
        lines: holdLinesOf(AREA, ['2027-08-27'], [19, 21, 22], 20),
        until: NOW + 86_400,
        by: 'Sana (STF-1)',
      },
      NOW + 200,
    );
    expect(await cell('2027-08-27', 19, NOW + 201)).toMatchObject({
      booked: 30,
      held: 20,
      free: 0,
    });
    await createBooking(
      pool,
      {
        bookingId: 'BK-CAL-3',
        brandId: 'chai-co',
        request: {
          lines: [
            line('2027-08-27', 19, 20),
            line('2027-08-27', 21, 20),
            line('2027-08-27', 22, 20),
          ],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'sana',
        holdId: 'HLD-CAL-3',
      },
      NOW + 300,
    );
    await moveBooking(
      pool,
      'BK-CAL-3',
      'awaiting-payment',
      { by: 'sana', actor: 'admin' },
      NOW + 301,
    );
    expect(await cell('2027-08-27', 19, NOW + 302)).toMatchObject({ booked: 50, held: 0, free: 0 });
    const h = (await calendarWeek(pool, AREA, '2027-08-23', NOW + 302)).holds.find(
      (x) => x.holdId === 'HLD-CAL-3',
    );
    expect(h?.bookingId).toBe('BK-CAL-3');
  });
});
