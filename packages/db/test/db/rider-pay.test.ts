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
import { accountTotals, trialBalance } from '../../src/ledger.js';
import { addScreenKey } from '../../src/plays.js';
import { accrueRiderPay, assignScreen, monthBounds, setPocBase } from '../../src/rider-pay.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const ADMIN = { id: 'priya', role: 'admin' } as const;
const PLACE = 'inside:hyd-madhapur@1';

/** India 08:00 on a day, in UTC seconds. */
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * A screen's minute summaries for `hours` a day from 08:00 India time, for `days` days from `day`
 * (written straight in: what the screen would have sent). `pay` is the pay-zone seconds a minute.
 */
async function ride(screen: string, day: string, days: number, hours: number, pay = 60) {
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screen,
  ]);
  for (let d = 0; d < days; d += 1) {
    const from = eightAm(addDays(day, d));
    const r = await pool.query<{ n: string }>(
      'SELECT coalesce(max(seq), 0) AS n FROM screen_reports WHERE screen_id = $1',
      [screen],
    );
    const seq = Number(r.rows[0]?.n ?? 0);
    await pool.query(
      `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
       SELECT $1, $2 + g, 'minute', to_timestamp($3 + (g - 1) * 60), '{}'::jsonb
         FROM generate_series(1, $4) g`,
      [screen, seq, from, hours * 60],
    );
    await pool.query(
      `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
         distance_m, plays, people, seconds_at, clock_at)
       SELECT $1, to_timestamp($3 + (g - 1) * 60), $2 + g, 60, $5, 60, 400, 0, 0, $6, $6
         FROM generate_series(1, $4) g`,
      [screen, seq, from, hours * 60, pay, JSON.stringify({ [PLACE]: 60 })],
    );
  }
}

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

const owed = async (rider: string) => {
  const t = await accountTotals(pool, 'rider-payable', { party: rider });
  return t.credit - t.debit;
};
const tdsOf = async (rider: string) => {
  const t = await accountTotals(pool, 'tds-payable', { party: rider });
  return t.credit - t.debit;
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  // After the POC (from September 2027 in this test): ₹25 an hour + 25% of what his hours sold.
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
}, 60_000);
afterAll(async () => db.drop());

describe('rider pay in the POC (P1.7.6)', () => {
  const AUG = '2027-08';
  const { start, end } = monthBounds(AUG);

  beforeAll(async () => {
    // R-AAA rides scr-a all month: 15 days × 10 h = 150 moving hours. R-BBB: 149 hours on scr-b.
    await assignScreen(pool, 'scr-a', 'R-AAA', start, 'fitter');
    await assignScreen(pool, 'scr-b', 'R-BBB', start, 'fitter');
    await ride('scr-a', '2027-08-02', 15, 10);
    await ride('scr-b', '2027-08-02', 14, 10);
    await ride('scr-b', '2027-08-20', 1, 9);
    // scr-c changes hands: R-CCC rides it the first 10 days (100 h), R-DDD the next 6 (60 h).
    await assignScreen(pool, 'scr-c', 'R-CCC', start, 'fitter');
    await assignScreen(pool, 'scr-c', 'R-DDD', eightAm('2027-08-12'), 'fitter');
    await ride('scr-c', '2027-08-02', 16, 10);
    // R-EEE rides outside the pay zone half of each minute: 150 h on the clock, 75 h counted.
    await assignScreen(pool, 'scr-e', 'R-EEE', start, 'fitter');
    await ride('scr-e', '2027-08-02', 15, 10, 30);
    await setPocBase(pool, 'R-AAA', AUG, 600_000, ADMIN, 'founding rider, full base');
    await setPocBase(pool, 'R-BBB', AUG, 200_000, ADMIN, 'founding rider, small base');
    await setPocBase(pool, 'R-EEE', AUG, 400_000, ADMIN, 'founding rider, mid base');
  }, 60_000);

  it('nothing is owed before the month ends: POC pay is paid once, after the month', async () => {
    const r = await accrueRiderPay(pool, AUG, end - 60);
    expect(r.failed).toEqual([]);
    expect(r.posted).toBe(0);
    expect(await owed('R-AAA')).toBe(0);
  });

  it('after the month: the base, and the ₹6,000 bonus only at 150+ moving hours in the pay zone, less 1% TDS', async () => {
    const r = await accrueRiderPay(pool, AUG, end + 60);
    expect(r.failed).toEqual([]);
    const by = new Map(r.pay.map((p) => [p.riderId, p]));
    expect(by.get('R-AAA')).toMatchObject({ base: 600_000, bonus: 600_000, gross: 1_200_000 });
    expect(by.get('R-BBB')).toMatchObject({ base: 200_000, bonus: 0, gross: 200_000 });
    expect(by.get('R-EEE')).toMatchObject({ countedSeconds: 75 * 3600, bonus: 0, gross: 400_000 });
    // A screen that changed hands: each rider gets only the hours he rode it.
    expect(by.get('R-CCC')?.countedSeconds).toBe(100 * 3600);
    expect(by.get('R-DDD')?.countedSeconds).toBe(60 * 3600);
    // No base set for R-DDD (open question 15): only the bonus could count, and he has no 150 h.
    expect(by.get('R-DDD')?.gross).toBe(0);
    expect(await owed('R-AAA')).toBe(1_200_000 - 12_000);
    expect(await tdsOf('R-AAA')).toBe(12_000);
    expect(await owed('R-BBB')).toBe(198_000);
  });

  it('running again changes nothing; late minutes are added and the pay moves with them', async () => {
    expect((await accrueRiderPay(pool, AUG, end + 120)).posted).toBe(0);
    // R-BBB's last hour arrives late (uploaded after the month): now 150 h, so the bonus is due.
    await ride('scr-b', '2027-08-21', 1, 1);
    const r = await accrueRiderPay(pool, AUG, end + 3600);
    expect(r.posted).toBe(1);
    expect(await owed('R-BBB')).toBe(800_000 - 8_000);
  });

  it('a base pays only riders who rode a screen that month; 0 ends a base', async () => {
    await setPocBase(pool, 'R-GONE', '2027-07', 600_000, ADMIN, 'left before August');
    await setPocBase(pool, 'R-BBB', '2027-09', 0, ADMIN, 'left at the end of August');
    const aug = await accrueRiderPay(pool, AUG, end + 7200);
    expect(aug.pay.find((p) => p.riderId === 'R-GONE')).toBeUndefined();
    expect(await owed('R-GONE')).toBe(0);
    const sep = monthBounds('2027-09');
    await assignScreen(pool, 'scr-b', null, sep.start, 'fitter');
    await assignScreen(pool, 'scr-b', 'R-BBB', sep.start + 86_400, 'fitter');
    const r = await accrueRiderPay(pool, '2027-09', sep.end + 60);
    expect(r.pay.find((p) => p.riderId === 'R-BBB')?.base ?? 0).toBe(0);
  });

  it('a rider is on one screen at a time', async () => {
    await expect(assignScreen(pool, 'scr-z', 'R-AAA', end - 86_400, 'fitter')).rejects.toThrow(
      /R-AAA is on scr-a/,
    );
  });

  it('a base can only be one of the bases in the price book, set by an admin', async () => {
    await expect(setPocBase(pool, 'R-XYZ', AUG, 500_000, ADMIN, 'not a real base')).rejects.toThrow(
      /Base must be 0 or one of ₹2000, ₹4000, ₹6000/,
    );
    await expect(
      setPocBase(pool, 'R-XYZ', AUG, 200_000, { id: 'r', role: 'rider' }, 'self-service'),
    ).rejects.toThrow(/admin/);
    await expect(setPocBase(pool, 'R-XYZ', '2027-13', 200_000, ADMIN, 'bad month')).rejects.toThrow(
      /YYYY-MM/,
    );
  });
});

describe('rider pay after the POC (P1.7.5)', () => {
  const SEP = '2027-09';
  const DAY = '2027-09-14';
  const LINE = lineIdOf('BK-R1', 'hyd-madhapur', DAY, 10);
  const { start, end } = monthBounds(SEP);

  beforeAll(async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-R1',
        brandId: 'brand-r1',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: DAY, startHour: 10, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-R1', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-R1', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    await moveBooking(pool, 'BK-R1', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
    // R-FFF rides scr-f; scr-g has no rider. Each delivers 200 of the line's 1,000 plays.
    await assignScreen(pool, 'scr-f', 'R-FFF', start, 'fitter');
    for (const s of ['scr-f', 'scr-g']) {
      await screenKey(s);
      const at = lineStartsAt({ date: DAY, startHour: 10 });
      await storeUpload(pool, s, plays(s, 200, at, LINE, 1), 1, at + 3500);
    }
    await ride('scr-f', DAY, 1, 10);
  }, 60_000);

  it('paid as the month goes: ₹25 a moving hour + 25% of what his plays sold, less 1% TDS', async () => {
    const r = await accrueRiderPay(pool, SEP, eightAm('2027-09-16'));
    expect(r.failed).toEqual([]);
    const f = r.pay.find((p) => p.riderId === 'R-FFF');
    // 10 h × ₹25 = ₹250; his 200 of 1,000 plays sold ₹300 of the ₹1,500 line: 25% = ₹75.
    expect(f).toMatchObject({ hourly: 25_000, soldPaise: 30_000, sold: 7_500, gross: 32_500 });
    expect(await owed('R-FFF')).toBe(32_500 - 325);
  });

  it('more hours later in the month: only the difference is posted', async () => {
    await ride('scr-f', '2027-09-20', 2, 10);
    const r = await accrueRiderPay(pool, SEP, end + 24 * 3600);
    expect(r.posted).toBe(1);
    expect(r.pay.find((p) => p.riderId === 'R-FFF')).toMatchObject({
      hourly: 75_000,
      final: false,
    });
    expect(await owed('R-FFF')).toBe(82_500 - 825);
  });

  it('once the month has closed, its pay never changes by itself: a late change is reported', async () => {
    await ride('scr-f', '2027-09-25', 1, 10);
    const r = await accrueRiderPay(pool, SEP, end + 49 * 3600);
    expect(r.posted).toBe(0);
    expect(r.late).toEqual([{ riderId: 'R-FFF', grossChange: 25_000 }]);
    expect(await owed('R-FFF')).toBe(82_500 - 825);
  });

  it('hourly pay stops at 260 moving hours a month', async () => {
    await assignScreen(pool, 'scr-h', 'R-HHH', start, 'fitter');
    await ride('scr-h', '2027-09-01', 27, 10); // 270 hours
    const r = await accrueRiderPay(pool, SEP, end + 24 * 3600);
    expect(r.pay.find((p) => p.riderId === 'R-HHH')).toMatchObject({
      countedSeconds: 270 * 3600,
      paidSeconds: 260 * 3600,
      hourly: 650_000,
    });
  });

  it('the whole ledger balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
