import {
  BookingError,
  launchAreas,
  PRICE_BOOK_V1,
  type BookingLine,
  type BookingRequest,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import {
  bookingState,
  CapacityError,
  createBooking,
  moveBooking,
  openQuotes,
  placeHold,
  PriceBookError,
  priceBooks,
  savePriceBook,
  setAreaHourLimit,
} from '../../src/bookings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Mon 23 Aug 2027, 10:00 India time.
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const HOUR = 3600;

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  // Areas approved for sale, and the price book.
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
});
afterAll(async () => db.drop());

const line = (
  date: string,
  startHour: number,
  bikes: number,
  areaId = 'hyd-madhapur',
): BookingLine => ({
  areaId,
  date,
  startHour,
  bikes,
});
const request = (lines: BookingLine[], channel: 'portal' | 'admin' = 'admin'): BookingRequest => ({
  lines,
  repeatMonths: 1,
  channel,
});

describe('price books', () => {
  it('are saved as versions and read back exactly', async () => {
    expect(await priceBooks(pool)).toEqual([PRICE_BOOK_V1]);
  });

  it('a broken book, or skipping a version, is refused', async () => {
    const broken = {
      ...PRICE_BOOK_V1,
      version: 2,
      validFrom: '2027-01-01T00:00:00.000Z',
      floorPaisePerBikeHour: 40_000,
    };
    await expect(savePriceBook(pool, broken, 'prateek')).rejects.toBeInstanceOf(PriceBookError);
    await expect(
      savePriceBook(
        pool,
        { ...PRICE_BOOK_V1, version: 3, validFrom: '2027-01-01T00:00:00.000Z' },
        'prateek',
      ),
    ).rejects.toThrow(/next version must be 2/);
  });
});

describe('bookings', () => {
  it('Biryani Hub: priced from the price book, saved as a draft, then through its steps', async () => {
    const lines: BookingLine[] = [];
    for (const date of ['2027-08-27', '2027-08-28', '2027-08-29'])
      lines.push(line(date, 19, 10), line(date, 20, 10));
    const q = await createBooking(
      pool,
      { bookingId: 'BK-0001', brandId: 'biryani-hub', request: request(lines), by: 'priya' },
      NOW,
    );
    expect([q.subtotal, q.gst, q.total]).toEqual([1_800_000, 324_000, 2_124_000]);
    const r = await pool.query<{ total_paise: string; price_book_version: number }>(
      "SELECT total_paise, price_book_version FROM bookings WHERE booking_id = 'BK-0001'",
    );
    expect(r.rows[0]).toEqual({ total_paise: '2124000', price_book_version: 1 });
    expect(await bookingState(pool, 'BK-0001')).toBe('draft');
    await moveBooking(pool, 'BK-0001', 'awaiting-payment', { by: 'priya', actor: 'admin' }, NOW);
    await moveBooking(pool, 'BK-0001', 'paid', { by: 'system', actor: 'system' }, NOW + 100);
    await expect(
      moveBooking(pool, 'BK-0001', 'running', { by: 'system', actor: 'system' }, NOW + 200),
    ).rejects.toThrow(/cannot go from paid/);
    expect(await bookingState(pool, 'BK-0001')).toBe('paid');
  });

  it('open quotes: paid drafts count until they move on (a new price version re-quotes them)', async () => {
    const before = await openQuotes(pool);
    await createBooking(
      pool,
      {
        bookingId: 'BK-OQ-1',
        brandId: 'quote-co',
        request: request([line('2027-08-30', 19, 30), line('2027-08-30', 20, 30)]),
        by: 'priya',
      },
      NOW,
    );
    expect(await openQuotes(pool)).toBe(before + 1);
    await moveBooking(pool, 'BK-OQ-1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, NOW);
    expect(await openQuotes(pool)).toBe(before);
  });

  it('the same rules as the domain: a portal brand cannot book for tomorrow', async () => {
    await expect(
      createBooking(
        pool,
        {
          bookingId: 'BK-0002',
          brandId: 'b2',
          request: request([line('2027-08-24', 18, 60)], 'portal'),
          by: 'b2',
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(BookingError);
  });

  it('booked rows can never be edited or deleted', async () => {
    await expect(
      pool.query("UPDATE bookings SET total_paise = 0 WHERE booking_id = 'BK-0001'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM booking_events WHERE booking_id = 'BK-0001'"),
    ).rejects.toThrow(/append-only/);
  });
});

describe('holds and manual limits', () => {
  const hour = line('2027-09-10', 18, 20);

  it('with a limit of 50: a hold for 30 leaves 20; a booking for 25 is refused until the hold ends', async () => {
    await setAreaHourLimit(pool, hour, 50, 'prateek');
    await placeHold(
      pool,
      {
        holdId: 'HD-0001',
        brandId: 'kesari',
        lines: [{ ...hour, bikes: 30 }],
        until: NOW + HOUR,
        by: 'priya',
      },
      NOW,
    );
    const big = request([{ ...hour, bikes: 25 }, line('2027-09-10', 20, 40)]);
    await expect(
      createBooking(
        pool,
        { bookingId: 'BK-0010', brandId: 'other', request: big, by: 'priya' },
        NOW,
      ),
    ).rejects.toBeInstanceOf(CapacityError);
    // The client with the hold can book against it.
    await createBooking(
      pool,
      {
        bookingId: 'BK-0011',
        brandId: 'kesari',
        request: request([{ ...hour, bikes: 50 }]),
        by: 'priya',
        holdId: 'HD-0001',
      },
      NOW,
    );
    await moveBooking(pool, 'BK-0011', 'awaiting-payment', { by: 'priya', actor: 'admin' }, NOW);
    // Now 50 of 50 are sold: nothing fits, even after the hold ends.
    await expect(
      createBooking(
        pool,
        {
          bookingId: 'BK-0012',
          brandId: 'other',
          request: request([{ ...hour, bikes: 5 }, line('2027-09-10', 19, 100)]),
          by: 'priya',
        },
        NOW + 2 * HOUR,
      ),
    ).rejects.toBeInstanceOf(CapacityError);
  });

  it('lifting the limit (a new version) makes the hour unlimited again; nothing is deleted', async () => {
    await setAreaHourLimit(pool, hour, null, 'prateek');
    await createBooking(
      pool,
      {
        bookingId: 'BK-0013',
        brandId: 'other',
        request: request([{ ...hour, bikes: 100 }]),
        by: 'priya',
      },
      NOW + 2 * HOUR,
    );
    const versions = await pool.query(
      "SELECT version FROM area_hour_limits WHERE area_id = 'hyd-madhapur' AND day = '2027-09-10'",
    );
    expect(versions.rowCount).toBe(2);
  });

  it('two drafts for the last limited bikes: only one can become a sale', async () => {
    const h = line('2027-09-11', 18, 30);
    const extra = line('2027-09-11', 19, 30);
    await setAreaHourLimit(pool, h, 40, 'prateek');
    // Drafts hold no bikes, so both drafts are allowed…
    for (const id of ['BK-0020', 'BK-0021']) {
      await createBooking(
        pool,
        { bookingId: id, brandId: id, request: request([h, extra]), by: 'x' },
        NOW,
      );
    }
    // …but when both try to become sales at the same moment, only one fits under the limit.
    const results = await Promise.allSettled(
      ['BK-0020', 'BK-0021'].map((id) =>
        moveBooking(pool, id, 'awaiting-payment', { by: 'x', actor: 'admin' }, NOW),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(CapacityError);
  });
});

describe('free trial', () => {
  const week = ['2027-09-20', '2027-09-21', '2027-09-22', '2027-09-23'].map((d) =>
    line(d, 18, 5, 'hyd-gachibowli'),
  );

  it('is free, and the same business can never get a second one, even asking twice at once', async () => {
    const biz = { phone: '+91 98490 11111', gstin: '36AAAAA1111A1Z1' };
    const results = await Promise.allSettled(
      ['TR-0001', 'TR-0002'].map((id) =>
        createBooking(
          pool,
          { bookingId: id, brandId: 'cafe', request: request(week), by: 'cafe', trialFor: biz },
          NOW,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const ok = results.find((r) => r.status === 'fulfilled');
    expect(ok?.status === 'fulfilled' && ok.value.total).toBe(0);
    await expect(
      createBooking(
        pool,
        {
          bookingId: 'TR-0003',
          brandId: 'cafe2',
          request: request(week),
          by: 'cafe',
          trialFor: { phone: '9849011111' },
        },
        NOW,
      ),
    ).rejects.toThrow(/already had its free trial/);
  });
});

describe('review fixes', () => {
  it("one brand cannot book against another brand's hold, or an ended hold", async () => {
    const h = line('2027-09-15', 18, 60);
    await setAreaHourLimit(pool, h, 60, 'prateek');
    await placeHold(
      pool,
      { holdId: 'HD-Y', brandId: 'brand-y', lines: [h], until: NOW + HOUR, by: 'priya' },
      NOW,
    );
    const r = request([h]);
    await expect(
      createBooking(
        pool,
        { bookingId: 'BK-X1', brandId: 'brand-x', request: r, by: 'x', holdId: 'HD-Y' },
        NOW,
      ),
    ).rejects.toThrow(/another brand/);
    await expect(
      createBooking(
        pool,
        { bookingId: 'BK-Y0', brandId: 'brand-y', request: r, by: 'y', holdId: 'HD-Y' },
        NOW + 2 * HOUR,
      ),
    ).rejects.toThrow(/has ended/);
    await createBooking(
      pool,
      { bookingId: 'BK-Y1', brandId: 'brand-y', request: r, by: 'y', holdId: 'HD-Y' },
      NOW,
    );
  });

  it('a hold that became a live booking is not counted twice for everyone else', async () => {
    const h = line('2027-09-16', 18, 60);
    await setAreaHourLimit(pool, h, 110, 'prateek');
    await placeHold(
      pool,
      { holdId: 'HD-H', brandId: 'brand-h', lines: [h], until: NOW + 5 * HOUR, by: 'priya' },
      NOW,
    );
    await createBooking(
      pool,
      { bookingId: 'BK-H1', brandId: 'brand-h', request: request([h]), by: 'h', holdId: 'HD-H' },
      NOW,
    );
    await moveBooking(pool, 'BK-H1', 'awaiting-payment', { by: 'h', actor: 'admin' }, NOW);
    // 110 − 60 sold = 50 really free, even though the hold has not ended yet.
    await createBooking(
      pool,
      { bookingId: 'BK-H2', brandId: 'other', request: request([{ ...h, bikes: 50 }]), by: 'o' },
      NOW,
    );
    await moveBooking(pool, 'BK-H2', 'awaiting-payment', { by: 'o', actor: 'admin' }, NOW);
  });

  it('after the ads deadline a brand cannot approve; staff can, with a reason', async () => {
    const lines = [line('2027-08-27', 19, 30), line('2027-08-27', 20, 30)];
    await createBooking(
      pool,
      { bookingId: 'BK-AD', brandId: 'late', request: request(lines), by: 'priya' },
      NOW,
    );
    await moveBooking(pool, 'BK-AD', 'awaiting-payment', { by: 'priya', actor: 'admin' }, NOW);
    await moveBooking(pool, 'BK-AD', 'paid', { by: 'gateway', actor: 'system' }, NOW);
    await expect(
      moveBooking(pool, 'BK-AD', 'ads-approved', { by: 'late', actor: 'brand' }, NOW),
    ).rejects.toThrow(/only RECALL staff/);
    await expect(
      moveBooking(pool, 'BK-AD', 'ads-approved', { by: 'arjun', actor: 'admin' }, NOW),
    ).rejects.toThrow(/reason/);
    await moveBooking(
      pool,
      'BK-AD',
      'ads-approved',
      { by: 'arjun', actor: 'admin', reason: 'Festival offer, brand sent late' },
      NOW,
    );
    const r = await pool.query<{ reason: string }>(
      "SELECT reason FROM booking_events WHERE booking_id = 'BK-AD' AND state = 'ads-approved'",
    );
    expect(r.rows[0]?.reason).toBe('Festival offer, brand sent late');
  });

  it('a draft made before a price change cannot go to payment at the old prices', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-PR',
        brandId: 'p',
        request: request([line('2027-10-20', 18, 60)]),
        by: 'priya',
      },
      NOW,
    );
    await savePriceBook(
      pool,
      { ...PRICE_BOOK_V1, version: 2, validFrom: '2027-08-23T05:00:00.000Z' },
      'prateek',
    );
    await expect(
      moveBooking(
        pool,
        'BK-PR',
        'awaiting-payment',
        { by: 'priya', actor: 'admin' },
        NOW + 2 * HOUR,
      ),
    ).rejects.toThrow(/Prices changed/);
  });
});
