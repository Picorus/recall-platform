import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  pocDayPaise,
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
import { setBusinessMode } from '../../src/business-mode.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import { addScreenKey } from '../../src/plays.js';
import {
  accrueRiderPay,
  assignScreen,
  givePocBonus,
  monthBounds,
  pocBonusList,
  pocFinishList,
} from '../../src/rider-pay.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
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
  // In this test the POC runs June–August 2027 (bases ₹2,000 / ₹4,000 / ₹6,000); September is after it.
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  // The business is switched to the POC on 1 June 2027 and back to regular business on 1 September.
  const SUPER_ADMIN = { id: 'prateek', role: 'super-admin' } as const;
  await setBusinessMode(pool, 'poc', SUPER_ADMIN, 'POC starts', Date.UTC(2027, 5, 1, 6) / 1000);
  await setBusinessMode(pool, 'regular', SUPER_ADMIN, 'POC over', Date.UTC(2027, 8, 1, 6) / 1000);
  // A later price book (same rider pay), in force from September.
  await savePriceBook(
    pool,
    {
      ...PRICE_BOOK_V1,
      version: 2,
      validFrom: '2027-09-01T00:00:00.000Z',
      minBookingPaise: 100_000,
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
    // R-AAA first got a screen in July, so August is his second month.
    await assignScreen(
      pool,
      'scr-a',
      'R-AAA',
      monthBounds('2027-07').start + 10 * 86_400,
      'fitter',
    );
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
    // R-GGG rode in July only: nothing in August.
    await assignScreen(pool, 'scr-g0', 'R-GGG', monthBounds('2027-07').start, 'fitter');
    await assignScreen(pool, 'scr-g0', null, monthBounds('2027-07').start + 86_400, 'fitter');
  }, 60_000);

  /** August is the POC's third month: the ₹6,000 base spread over its 31 days. */
  const days = (from: number, to: number) => {
    let n = 0;
    for (let d = from; d <= to; d += 1) n += pocDayPaise(600_000, 31, d);
    return n;
  };
  const tds = (gross: number) => Math.floor((gross * 100 + 5_000) / 10_000);

  it('the base is paid as the days go, for the Monday payout: the first week is 7 days of ₹6,000 ÷ 31', async () => {
    // 8 Aug 02:00 India time: days 1–7 have ended.
    const r = await accrueRiderPay(pool, AUG, eightAm('2027-08-08') - 6 * 3600);
    expect(r.failed).toEqual([]);
    expect(days(1, 7)).toBe(135_483);
    expect(r.pay.find((p) => p.riderId === 'R-AAA')).toMatchObject({ poc: 135_483 });
    expect(await owed('R-AAA')).toBe(135_483 - tds(135_483));
  });

  it("a full month is exactly the month's base; a rider gets it for the days he held a screen", async () => {
    const r = await accrueRiderPay(pool, AUG, end + 60);
    expect(r.failed).toEqual([]);
    const by = new Map(r.pay.map((p) => [p.riderId, p]));
    // Hours do not change the base: R-EEE (75 h) gets it like R-AAA (150 h). No sales share.
    for (const id of ['R-AAA', 'R-BBB', 'R-EEE'])
      expect(by.get(id)).toMatchObject({ gross: 600_000, sold: 0 });
    // A screen that changed hands on 12 Aug at 08:00: R-CCC to the 11th, R-DDD from the 12th.
    expect(by.get('R-CCC')?.pocDays).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(by.get('R-CCC')?.gross).toBe(days(1, 11));
    expect(by.get('R-DDD')?.gross).toBe(days(12, 31));
    expect(days(1, 11) + days(12, 31)).toBe(600_000);
    // POC hours pay no hourly rate (they count for the founding bonus).
    expect(by.get('R-AAA')).toMatchObject({ countedSeconds: 0, hourly: 0 });
    expect(by.has('R-GGG')).toBe(false);
    expect(await owed('R-AAA')).toBe(600_000 - 6_000);
    expect(await tdsOf('R-AAA')).toBe(6_000);
    // Running again changes nothing.
    expect((await accrueRiderPay(pool, AUG, end + 120)).posted).toBe(0);
  });

  it("the month's founding bonus: full at 150 h, in proportion from 100 h, none below; a super admin gives it once the month closes", async () => {
    const closed = end + 49 * 3600;
    await expect(givePocBonus(pool, 'R-AAA', AUG, SUPER, end + 60)).rejects.toThrow(/closed/);
    const list = new Map((await pocBonusList(pool, AUG)).map((r) => [r.riderId, r]));
    expect(list.get('R-AAA')).toMatchObject({ amountPaise: 600_000, given: false });
    expect(list.get('R-BBB')).toMatchObject({ countedSeconds: 149 * 3600, amountPaise: 588_000 });
    // A screen that changed hands: each rider's hours only while he rode it.
    expect(list.get('R-CCC')).toMatchObject({ countedSeconds: 100 * 3600, amountPaise: 0 }); // starts above 100 h
    expect(list.get('R-DDD')?.countedSeconds).toBe(60 * 3600);
    expect(list.get('R-EEE')?.amountPaise).toBe(0); // half his minutes outside the 15 km zone
    await expect(
      givePocBonus(pool, 'R-AAA', AUG, { id: 'priya', role: 'admin' }, closed),
    ).rejects.toThrow(/super admin/);
    await expect(givePocBonus(pool, 'R-EEE', AUG, SUPER, closed)).rejects.toThrow(
      /75 moving hours/,
    );
    expect(await givePocBonus(pool, 'R-AAA', AUG, SUPER, closed)).toBe(600_000);
    expect(await owed('R-AAA')).toBe(594_000 + 594_000);
    await expect(givePocBonus(pool, 'R-AAA', AUG, SUPER, closed)).rejects.toThrow(/already/);
    // R-BBB's last hour arrives late: now 150 h, so his bonus is in full.
    await ride('scr-b', '2027-08-21', 1, 1);
    expect(await givePocBonus(pool, 'R-BBB', AUG, SUPER, closed + 60)).toBe(600_000);
    await expect(givePocBonus(pool, 'R-AAA', '2027-09', SUPER, closed)).rejects.toThrow(
      /not a POC month/,
    );
  });

  it('₹3,000 more for riders who finish the POC and keep the screen (the POC ends with the switch)', async () => {
    const closed = eightAm('2027-09-03'); // 48 hours after the switch back on 1 Sep, 08:00
    await expect(givePocBonus(pool, 'R-AAA', undefined, SUPER, closed - 60)).rejects.toThrow(
      /closed/,
    );
    // The POC ended with the switch on 1 September at 08:00; R-CCC had handed his screen on.
    expect((await pocFinishList(pool)).map((r) => r.riderId)).toEqual([
      'R-AAA',
      'R-BBB',
      'R-DDD',
      'R-EEE',
    ]);
    expect(await givePocBonus(pool, 'R-AAA', undefined, SUPER, closed)).toBe(300_000);
    expect(await owed('R-AAA')).toBe(594_000 + 594_000 + 297_000);
    await expect(givePocBonus(pool, 'R-CCC', undefined, SUPER, closed)).rejects.toThrow(
      /did not keep a screen/,
    );
  });

  it('the switch: only a super admin, once a day, counted from that business day', async () => {
    await expect(
      setBusinessMode(pool, 'poc', { id: 'priya', role: 'admin' }, 'try it', end + 86_400 * 40),
    ).rejects.toThrow(/super admin/);
    await expect(
      setBusinessMode(pool, 'regular', SUPER, 'again', end + 86_400 * 40),
    ).rejects.toThrow(/already on regular/);
  });

  it('a rider is on one screen at a time', async () => {
    await expect(assignScreen(pool, 'scr-z', 'R-AAA', end - 86_400, 'fitter')).rejects.toThrow(
      /R-AAA is on scr-a/,
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
