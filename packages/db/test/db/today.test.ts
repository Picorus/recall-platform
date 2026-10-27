// P3.2: the Today page's numbers from a sample day: bikes now, hours sold vs delivered, make-ups
// owed, refunds this week, open alerts.
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  newScreenId,
  playBytes,
  PRICE_BOOK_V1,
  weekStartOf,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { settleDue } from '../../src/makeups.js';
import { addScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { recordHello } from '../../src/screen-line.js';
import {
  alertsNow,
  fleetNow,
  hoursSoldToday,
  makeUpsOwed,
  refundsThisWeek,
} from '../../src/today.js';
import { freshDatabase, chooseAds } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const AT = (h: number, m = 0) => lineStartsAt({ date: DATE, startHour: h }) + m * 60;
const NOW = AT(18, 30); // 6:30 pm on the day
const L17 = lineIdOf('BK-T17', 'hyd-madhapur', DATE, 17);

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
      slot: 'brand',
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

async function book(
  id: string,
  startHour: number,
  bikes: number,
  to: 'paid' | 'awaiting-payment' | 'cancelled',
) {
  await createBooking(
    pool,
    {
      bookingId: id,
      brandId: `brand-${id}`,
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour, bikes }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, id, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  if (to === 'awaiting-payment') return;
  await moveBooking(pool, id, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await chooseAds(pool, id);
  if (to === 'paid')
    await moveBooking(pool, id, 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
  if (to === 'cancelled')
    await moveBooking(
      pool,
      id,
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand asked' },
      BOOKED + 120,
    );
}

let n = 0;
const sid = () => newScreenId([n++, 7, 3, 9, 1, 4, 2]);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  await book('BK-T17', 17, 5, 'paid'); // 1,000 plays
  await book('BK-T18', 18, 5, 'paid'); // running at 6:30 pm
  await book('BK-T21', 21, 5, 'paid'); // later tonight
  await book('BK-TX', 19, 5, 'cancelled');
  await book('BK-TU', 20, 5, 'awaiting-payment');
  // 900 of the 17:00 line's 1,000 plays, from 4 screens.
  for (const s of ['p1', 'p2', 'p3', 'p4']) {
    await playKey(s);
    await storeUpload(pool, s, plays(s, 225, AT(17), L17), 1, AT(17, 59));
  }
}, 120_000);
afterAll(async () => db.drop());

describe('the Today page (P3.2)', () => {
  it('hours sold vs delivered: paid lines only; delivered counts the hours already over', async () => {
    const h = await hoursSoldToday(pool, NOW);
    expect(h).toEqual({
      day: DATE,
      soldBikeHours: 15, // 5 + 5 + 5; the cancelled and the unpaid bookings are not sold
      soldPlays: 3_000,
      dueBikeHours: 5,
      duePlays: 1_000,
      deliveredBikeHours: 4.5,
      deliveredPlays: 900,
      runningBikeHours: 5,
    });
    // At 1:30 am the day still runs; at 5 am the page shows the day that just ended.
    expect((await hoursSoldToday(pool, AT(25, 30))).day).toBe(DATE);
    expect((await hoursSoldToday(pool, AT(29))).day).toBe(DATE);
  });

  it('make-ups owed: open, still owing, soonest first', async () => {
    await settleDue(pool, AT(18, 10));
    const owed = await makeUpsOwed(pool, NOW);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      makeUpId: `${L17}#1`,
      brandId: 'brand-BK-T17',
      areaId: 'hyd-madhapur',
      plays: 100,
      left: 100,
    });
    // Once its window is over it is no longer owed here (settling decides what comes next).
    expect(await makeUpsOwed(pool, (owed[0]?.until ?? 0) + 1)).toEqual([]);
  });

  it('refunds this week (Monday 00:00 India time onwards), by decision, with GST', async () => {
    const monday = weekStartOf(NOW);
    // What settling already proposed this week (the cancelled booking's refund).
    const before = await refundsThisWeek(pool, NOW);
    expect(new Date((monday + 19_800) * 1000).toISOString()).toBe('2027-08-23T00:00:00.000Z');
    const add = async (line: string, booking: string, base: number, gst: number, at: number) =>
      pool.query(
        `INSERT INTO refunds (refund_id, line_id, booking_id, missing_plays, promised_plays, paid_paise,
                              base_paise, gst_paise, price_book_version, proposed_at)
         VALUES ($1 || '#refund', $1, $2, 10, 100, 100000, $3, $4, 1, to_timestamp($5))`,
        [line, booking, base, gst, at],
      );
    await add('BK-T17/a', 'BK-T17', 10_000, 1_800, NOW - 3600);
    await add('BK-T17/b', 'BK-T17', 20_000, 3_600, monday + 60);
    await add('BK-T18/c', 'BK-T18', 5_000, 900, monday + 120);
    await add('BK-T18/old', 'BK-T18', 99_000, 0, monday - 60); // last week
    await pool.query(
      `INSERT INTO refund_decisions (refund_id, decision, decided_by, reason, decided_at)
       VALUES ('BK-T17/b#refund', 'approved', 'prateek', 'short by 10', now()),
              ('BK-T18/c#refund', 'rejected', 'prateek', 'brand was told', now())`,
    );
    await pool.query(
      `INSERT INTO refund_topups (refund_id, booking_id, missing_plays, base_paise, gst_paise, decided_by, decided_at)
       VALUES ('BK-T17/b#refund', 'BK-T17', 5, 1_000, 180, 'prateek', now())`,
    );
    expect(await refundsThisWeek(pool, NOW)).toEqual({
      since: monday,
      proposed: before.proposed + 3,
      waiting: before.waiting + 1,
      waitingPaise: before.waitingPaise + 11_800,
      approved: before.approved + 1,
      approvedPaise: before.approvedPaise + 24_780, // 20,000 + 3,600 + top-up 1,000 + 180
      rejected: before.rejected + 1,
    });
  });

  it('bikes now: moving, stopped, at the hub, offline', async () => {
    // Real time here: "heard from" uses the database's own receive time.
    const now = Math.floor(Date.now() / 1000);
    const ids = Array.from({ length: 6 }, sid);
    for (const [i, id] of ids.entries()) {
      await pool.query(
        `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
         VALUES ($1, $2, 'VendorX LED28 v1', 'warehouse-1', to_timestamp($3))`,
        [id, `RK-TODAY-${i}`, now - 86_400],
      );
    }
    const fit = (id: string, plate: string | null, at: number) =>
      pool.query(
        `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by)
         VALUES ($1, to_timestamp($2), $3, $4, 'fitting', 'fitter')`,
        [id, at, plate, plate ? `R-${plate}` : null],
      );
    const [moving, stopped, helloOnly, silent, hub, takenOff] = ids as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await fit(moving, 'TS09EA0001', now - 3600);
    await fit(stopped, 'TS09EA0002', now - 3600);
    await fit(helloOnly, 'TS09EA0003', now - 3600);
    await fit(silent, 'TS09EA0004', now - 3600);
    await fit(takenOff, 'TS09EA0006', now - 7200);
    await fit(takenOff, null, now - 3600);
    const live = (id: string, t: number, isMoving: boolean): Numbered[] => [
      {
        seq: 1,
        at: t,
        report: {
          kind: 'live',
          t,
          lat: 17.448,
          lng: 78.395,
          place: 'inside:hyd-madhapur@1',
          moving: isMoving,
        },
      },
    ];
    await storeUpload(pool, moving, live(moving, now - 30, true), 1, now);
    await storeUpload(pool, stopped, live(stopped, now - 30, false), 1, now);
    await recordHello(pool, helloOnly, '0.12.0', (now - 60) * 1000);
    void hub;
    expect(await fleetNow(pool, now)).toEqual({
      moving: 1,
      stopped: 2,
      offline: 1,
      atHub: 2,
      total: 6,
    });
    // Ten minutes later nobody has been heard from: every fitted bike is offline.
    expect(await fleetNow(pool, now + 600)).toEqual({
      moving: 0,
      stopped: 0,
      offline: 4,
      atHub: 2,
      total: 6,
    });
  });

  it('open alerts with the bike each screen is on, oldest first', async () => {
    const now = Math.floor(Date.now() / 1000);
    const s = await pool.query<{ screen_id: string }>(
      "SELECT screen_id FROM screen_fittings WHERE bike = 'TS09EA0001'",
    );
    const id = s.rows[0]?.screen_id ?? '';
    await pool.query(
      `INSERT INTO screen_alert_events (screen_id, kind, state, at) VALUES
         ($1, 'overheating', 'raised', to_timestamp($2)),
         ($1, 'low-battery', 'raised', to_timestamp($3)),
         ($1, 'low-battery', 'cleared', to_timestamp($4))`,
      [id, now - 600, now - 900, now - 300],
    );
    const a = await alertsNow(pool, now);
    expect(a).toEqual({
      total: 1,
      list: [{ screenId: id, bike: 'TS09EA0001', kind: 'overheating', since: now - 600 }],
    });
  });
});
