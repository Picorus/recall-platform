// Found in review (P1.7.5): sales of a make-up played after the month went to nobody.
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  playBytes,
  PRICE_BOOK_V1,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { addScreenKey } from '../../src/plays.js';
import { accrueRiderPay, assignScreen, monthBounds } from '../../src/rider-pay.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const PLACE = 'inside:hyd-madhapur@1';

/** India 08:00 on a day, in UTC seconds. */
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;

const keys = new Map<string, ReturnType<typeof generateKeyPairSync>['privateKey']>();
async function screenKey(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  keys.set(id, privateKey);
  await addScreenKey(
    pool,
    id,
    'k1',
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
}
/** `n` signed plays for a line, 15 s apart, inside Madhapur. */
function plays(id: string, n: number, start: number, ref: string, firstSeq: number): Numbered[] {
  const k = keys.get(id);
  if (!k) throw new Error('no key');
  return Array.from({ length: n }, (_, i) => {
    const seq = firstSeq + i;
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref,
      adId: 'ad-1',
      startAt: start + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: PLACE,
      people: 0,
    };
    const sig = sign('sha256', Buffer.from(playBytes(id, seq, body)), {
      key: k,
      dsaEncoding: 'der',
    });
    return { seq, at: body.startAt + 15, report: { ...body, sig: sig.toString('base64') } };
  });
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  await savePriceBook(
    pool,
    {
      ...PRICE_BOOK_V1,
      version: 2,
      validFrom: '2027-09-01T00:00:00.000Z',
      minBookingPaise: 100_000,
      riderPay: { ...PRICE_BOOK_V1.riderPay, mode: 'standard' },
    },
    'prateek',
  );
}, 120_000);
afterAll(async () => db.drop());

describe('repro', () => {
  const SEP = '2027-09';
  const DAY = '2027-09-30';
  const LINE = lineIdOf('BK-X', 'hyd-madhapur', DAY, 10);
  const { start, end } = monthBounds(SEP);

  it("a last-day line's make-up plays the next day: its sales go to whoever rode the screen then", async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-X',
        brandId: 'b-x',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: DAY, startHour: 10, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-X', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-X', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    await moveBooking(pool, 'BK-X', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
    await assignScreen(pool, 'scr-x', 'R-OLD', start, 'fitter');
    await screenKey('scr-x');
    const at = lineStartsAt({ date: DAY, startHour: 10 });
    await storeUpload(pool, 'scr-x', plays('scr-x', 200, at, LINE, 1), 1, at + 3500);
    // second make-up: same hour next day (1 Oct), as makeUpWindows gives
    const at2 = lineStartsAt({ date: '2027-10-01', startHour: 10 });
    await pool.query(
      `INSERT INTO make_ups (make_up_id, line_id, booking_id, area_id, stage, day, hours,
        window_from, window_until, plays) VALUES ($1,$2,'BK-X','hyd-madhapur',2,'2027-10-01','{10}',
        to_timestamp($3), to_timestamp($3 + 3600), 200)`,
      [`${LINE}#2`, LINE, at2],
    );
    // handover on 1 Oct 09:00 IST (after end+3600 = 03:00 IST)
    await assignScreen(pool, 'scr-x', 'R-NEW', eightAm('2027-10-01') + 3600, 'fitter');
    await storeUpload(pool, 'scr-x', plays('scr-x', 200, at2, `${LINE}#2`, 201), 201, at2 + 3500);
    const { countedPlaysFor } = await import('../../src/plays.js');
    expect((await countedPlaysFor(pool, `${LINE}#2`)).length).toBe(200); // the make-up plays count
    const r = await accrueRiderPay(pool, SEP, end + 49 * 3600);
    expect(r.failed).toEqual([]);
    const sold = Object.fromEntries(r.pay.map((p) => [p.riderId, p.soldPaise]));
    console.log('sold by rider', sold);
    // R-NEW rode scr-x when the 200 make-up plays played: should have 200/1000 of ₹1,500 = ₹300
    expect(sold['R-NEW'] ?? 0).toBe(30_000);
  });
});
