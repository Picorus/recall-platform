// P3.10: each booking line's delivery from real signed plays: live, counting, short with a make-up,
// delivered; a booking's lines and a business day's.
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
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { bookingDelivery, dayDelivery } from '../../src/delivery.js';
import { settleDue } from '../../src/makeups.js';
import { addScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const AT = (h: number, m = 0) => lineStartsAt({ date: DATE, startHour: h }) + m * 60;
const L17 = lineIdOf('BK-D1', 'hyd-madhapur', DATE, 17);

const keys = new Map<string, ReturnType<typeof generateKeyPairSync>['privateKey']>();
const seqs = new Map<string, number>();
async function playKey(id: string) {
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
function plays(id: string, n: number, start: number, ref: string): Numbered[] {
  const k = keys.get(id);
  if (!k) throw new Error('no key');
  return Array.from({ length: n }, (_, i) => {
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: ref.includes('#') ? 'make-up' : 'brand',
      ref,
      adId: 'ad-1',
      startAt: start + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: 'inside:hyd-madhapur@1',
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
  // 5 bikes at 17:00 and 21:00: 1,000 plays each.
  await createBooking(
    pool,
    {
      bookingId: 'BK-D1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: DATE, startHour: 17, bikes: 5 },
          { areaId: 'hyd-madhapur', date: DATE, startHour: 21, bikes: 5 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, 'BK-D1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, 'BK-D1', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await moveBooking(pool, 'BK-D1', 'ads-approved', { by: 'ravi', actor: 'admin' }, BOOKED + 120);
  // 900 of the 17:00 line's plays, from 4 screens.
  for (const s of ['d1', 'd2', 'd3', 'd4']) {
    await playKey(s);
    await storeUpload(pool, s, plays(s, 225, AT(17), L17), 1, AT(17, 59));
  }
}, 120_000);
afterAll(async () => db.drop());

describe('delivery (P3.10)', () => {
  it('a line live, counting late uploads, then short with a make-up that delivers the rest', async () => {
    const at = async (now: number) => (await bookingDelivery(pool, 'BK-D1', now))[0];
    expect(await at(AT(17, 59))).toMatchObject({
      lineId: L17,
      brandName: 'chai-co',
      areaName: 'Madhapur',
      bikes: 5,
      promised: 1_000,
      counted: 900,
      bikesSeen: 4,
      view: { status: 'live', delivered: 900, missing: 100 },
    });
    expect((await at(AT(18, 5)))?.view.status).toBe('counting');
    await settleDue(pool, AT(18, 10));
    const short = await at(AT(18, 15));
    expect(short?.view).toMatchObject({ status: 'make-up', missing: 100 });
    expect(short?.makeUps).toMatchObject([
      { makeUpId: `${L17}#1`, stage: 1, owed: 100, counted: 0, from: AT(18), until: AT(20) },
    ]);
    // The make-up's plays (one screen, from 18:20) make up the rest: delivered.
    await storeUpload(pool, 'd1', plays('d1', 100, AT(18, 20), `${L17}#1`), 2, AT(18, 50));
    const done = await at(AT(19));
    expect(done?.makeUps[0]?.counted).toBe(100);
    expect(done?.view).toMatchObject({ status: 'delivered', delivered: 1_000, missing: 0 });
  });

  it('a business day: its sold lines in time order', async () => {
    const day = await dayDelivery(pool, DATE, AT(18));
    expect(day.map((l) => [l.startHour, l.view.status])).toEqual([
      [17, 'delivered'], // decided and made up (the test above)
      [21, 'upcoming'],
    ]);
    expect(await dayDelivery(pool, '2027-08-25', AT(18))).toEqual([]);
  });
});
