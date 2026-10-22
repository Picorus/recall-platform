import { launchAreas, PRICE_BOOK_V1, type BookingLine, type Numbered } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { CapacityError, createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { storeUpload } from '../../src/screen-reports.js';
import { forecastLimits, offerForRequest, setSupplyEstimate } from '../../src/supply.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Mon 3 Apr 2028, 10:00 India time: after the POC.
const NOW = Date.UTC(2028, 3, 3, 4, 30) / 1000;
const FORECAST = {
  ...PRICE_BOOK_V1,
  version: 2,
  validFrom: '2028-01-01T00:00:00.000Z',
  capacity: { ...PRICE_BOOK_V1.capacity, mode: 'forecast' as const },
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
});
afterAll(async () => db.drop());

const line = (areaId: string, date: string, startHour: number, bikes: number): BookingLine => ({
  areaId,
  date,
  startHour,
  bikes,
});
const book = (id: string, lines: BookingLine[], now = NOW) =>
  createBooking(
    pool,
    {
      bookingId: id,
      brandId: id,
      request: { lines, repeatMonths: 1, channel: 'admin' },
      by: 'priya',
    },
    now,
  );

describe('POC: no forecast', () => {
  it('any number of bikes can be booked (only manual limits apply)', async () => {
    await book(
      'BK-POC1',
      [line('hyd-madhapur', '2027-09-14', 18, 500)],
      Date.UTC(2027, 7, 23, 4, 30) / 1000,
    );
  });
});

describe('after the POC: sell what the area can carry', () => {
  it('switching to forecast mode is a new price book version', async () => {
    await savePriceBook(pool, FORECAST, 'prateek');
  });

  it('no history and no estimate: nothing is sold blind', async () => {
    await expect(
      book('BK-F1', [line('hyd-kondapur', '2028-04-11', 18, 60)]),
    ).rejects.toBeInstanceOf(CapacityError);
  });

  it("with the super admin's starting estimate of 80: 80 fit, 81 do not", async () => {
    await setSupplyEstimate(pool, 'hyd-kondapur', 18, 80, 'prateek');
    await expect(
      book('BK-F2', [line('hyd-kondapur', '2028-04-11', 18, 81)]),
    ).rejects.toBeInstanceOf(CapacityError);
    await book('BK-F3', [line('hyd-kondapur', '2028-04-11', 18, 80)]);
  });

  it('five past Tuesdays with 20 bikes riding Gachibowli 6–7 pm: 18 can be sold (10% kept for make-ups)', async () => {
    // Screens report one minute summary per minute; 20 screens × 60 minutes × 5 Tuesdays.
    const tuesdays = ['2028-02-29', '2028-03-07', '2028-03-14', '2028-03-21', '2028-03-28'];
    for (let s = 0; s < 20; s++) {
      const batch: Numbered[] = [];
      for (const d of tuesdays) {
        const six = Date.parse(`${d}T12:30:00Z`) / 1000; // 18:00 India time
        for (let m = 0; m < 60; m++) {
          batch.push({
            seq: batch.length + 1,
            at: six + m * 60 + 60,
            report: {
              kind: 'minute',
              minute: six + m * 60,
              secondsAt: { 'inside:hyd-gachibowli@1': 60 },
              clockSeconds: 60,
              clockAt: { 'inside:hyd-gachibowli@1': 60 },
              payClockSeconds: 60,
              movingSeconds: 60,
              distanceM: 300,
              plays: 0,
              people: 0,
            },
          });
        }
      }
      await storeUpload(pool, `scr-${s}`, batch, 1);
    }
    const limits = await forecastLimits(
      pool,
      [line('hyd-gachibowli', '2028-04-11', 18, 1)],
      FORECAST.capacity,
      NOW,
    );
    expect(limits.get('hyd-gachibowli|2028-04-11|18')).toBe(18);
    // A different weekday has no history.
    const wed = await forecastLimits(
      pool,
      [line('hyd-gachibowli', '2028-04-12', 18, 1)],
      FORECAST.capacity,
      NOW,
    );
    expect(wed.get('hyd-gachibowli|2028-04-12|18')).toBe(0);
  }, 60_000);

  it("Prateek's example: Madhapur 6–7 pm carries 150; A pays for 100; B asks for 100 → 50 there + suggestions", async () => {
    await setSupplyEstimate(pool, 'hyd-madhapur', 18, 150, 'prateek');
    await setSupplyEstimate(pool, 'hyd-hitech-city', 18, 70, 'prateek');
    await setSupplyEstimate(pool, 'hyd-madhapur', 19, 90, 'prateek');
    await book('BK-A', [line('hyd-madhapur', '2028-04-11', 18, 100)]);
    await moveBooking(pool, 'BK-A', 'awaiting-payment', { by: 'a', actor: 'brand' }, NOW);
    const offer = await offerForRequest(pool, [line('hyd-madhapur', '2028-04-11', 18, 100)], NOW);
    expect(offer.fits).toEqual([line('hyd-madhapur', '2028-04-11', 18, 50)]);
    const sugg = (offer.short[0]?.suggestions ?? []).map((x) => [
      x.line.areaId,
      x.line.startHour,
      x.line.bikes,
    ]);
    // Nearby areas come first (Hitech City has 70 free), then other hours (Madhapur 7–8 pm has 90).
    expect(sugg[0]).toEqual(['hyd-hitech-city', 18, 50]);
    expect(sugg).toContainEqual(['hyd-madhapur', 19, 50]);
  });
});
