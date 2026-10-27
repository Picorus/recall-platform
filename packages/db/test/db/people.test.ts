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
import { bookingPeople } from '../../src/people.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase, chooseAds } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const PLACE = 'inside:hyd-madhapur@1';

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
function plays(
  id: string,
  n: number,
  start: number,
  ref: string,
  firstSeq: number,
  people: (i: number) => number,
): Numbered[] {
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
      people: people(i),
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
}, 120_000);
afterAll(async () => db.drop());

describe('people counts for a booking (P1.8.2–3)', () => {
  const DAY = '2027-09-30';
  const LINE = lineIdOf('BK-P', 'hyd-madhapur', DAY, 10);

  it('summed over the plays that count for the line and its make-up, shown only as a range', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-P',
        brandId: 'b-p',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: DAY, startHour: 10, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-P', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-P', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    await chooseAds(pool, 'BK-P');
    await moveBooking(pool, 'BK-P', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
    await screenKey('scr-p');
    const at = lineStartsAt({ date: DAY, startHour: 10 });
    // 200 plays with 30 people each; one faulty play says 90,000 and is taken as 150.
    const first = plays('scr-p', 200, at, LINE, 1, (i) => (i === 7 ? 90_000 : 30));
    await storeUpload(pool, 'scr-p', first, 1, at + 3500);
    // The make-up, next day, 100 plays with 12 people each.
    const at2 = lineStartsAt({ date: '2027-10-01', startHour: 10 });
    await pool.query(
      `INSERT INTO make_ups (make_up_id, line_id, booking_id, area_id, stage, day, hours,
        window_from, window_until, plays) VALUES ($1,$2,'BK-P','hyd-madhapur',2,'2027-10-01','{10}',
        to_timestamp($3), to_timestamp($3 + 3600), 100)`,
      [`${LINE}#2`, LINE, at2],
    );
    await storeUpload(
      pool,
      'scr-p',
      plays('scr-p', 100, at2, `${LINE}#2`, 201, () => 12),
      201,
      at2 + 3500,
    );

    const p = await bookingPeople(pool, 'BK-P');
    // 199 × 30 + 150 + 100 × 12 = 7,320 → 6,222–8,418 → 6,200–8,500
    expect(p).toMatchObject({ plays: 300, cappedPlays: 1 });
    expect(p?.estimate).toEqual({
      low: 6_200,
      high: 8_500,
      approximate: true,
      text: '6,200–8,500 people (approximate)',
    });
    expect(p?.lines).toEqual([
      {
        lineId: LINE,
        areaId: 'hyd-madhapur',
        day: DAY,
        startHour: 10,
        plays: 300,
        estimate: p?.estimate,
      },
    ]);
    // Nothing exact is handed out.
    expect(JSON.stringify(p)).not.toContain('7320');
    expect(await bookingPeople(pool, 'BK-NONE')).toBeUndefined();
  });

  it('a report that carries a picture is set aside, and the picture is not stored', async () => {
    const picture = `data:image/jpeg;base64,${'Q'.repeat(20_000)}`;
    const report = {
      kind: 'minute',
      minute: 1_800_000_000,
      secondsAt: {},
      clockSeconds: 0,
      clockAt: {},
      payClockSeconds: 0,
      movingSeconds: 0,
      distanceM: 0,
      plays: 0,
      people: 3,
      photo: picture,
    };
    const r = await storeUpload(
      pool,
      'scr-q',
      [{ seq: 1, at: 1_800_000_060, report: report as unknown as Numbered['report'] }],
      1,
      1_800_000_100,
    );
    expect(r.rejected).toBe(1);
    const row = await pool.query<{ body: unknown; reject_reason: string }>(
      `SELECT body, reject_reason FROM screen_reports WHERE screen_id = 'scr-q'`,
    );
    expect(row.rows[0]?.reject_reason).toBe('unknown field: photo');
    expect(JSON.stringify(row.rows[0]?.body)).not.toContain('QQQQ');
  });
});
