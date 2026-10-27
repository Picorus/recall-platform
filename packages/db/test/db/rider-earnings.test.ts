// P4.5: the rider app's Earnings page for a month: days, weeks and parts; the share of sales as of
// the pay run's last update; a closed month as the pay run posted it; the POC bonus progress.
import { DEFAULT_RIDER_PAY_RULES as PAY, pocDayPaise, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { riderEarnings, riderMonths } from '../../src/rider-earnings.js';
import { accrueRiderPay, assignScreen } from '../../src/rider-pay.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const PLACE = 'inside:hyd-madhapur@1';
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;
const H = 3600;

/** `hours` of riding from 08:00 India time on each of `days`. */
async function ride(screen: string, days: readonly string[], hours: number) {
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screen,
  ]);
  for (const day of days) {
    const r = await pool.query<{ n: string }>(
      'SELECT coalesce(max(seq), 0) AS n FROM screen_reports WHERE screen_id = $1',
      [screen],
    );
    const seq = Number(r.rows[0]?.n ?? 0);
    await pool.query(
      `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
       SELECT $1, $2 + g, 'minute', to_timestamp($3 + (g - 1) * 60), '{}'::jsonb
         FROM generate_series(1, $4) g`,
      [screen, seq, eightAm(day), hours * 60],
    );
    await pool.query(
      `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
         distance_m, plays, people, seconds_at, clock_at)
       SELECT $1, to_timestamp($3 + (g - 1) * 60), $2 + g, 60, 60, 60, 400, 0, 0, $5, $5
         FROM generate_series(1, $4) g`,
      [screen, seq, eightAm(day), hours * 60, JSON.stringify({ [PLACE]: 60 })],
    );
  }
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await assignScreen(pool, 'scr-e', 'R-EARN', eightAm('2027-07-01'), 'fitter');
}, 60_000);
afterAll(async () => db.drop());

describe('rider app Earnings (P4.5)', () => {
  it('a month so far, a pay update, then the closed month as the pay run posted it', async () => {
    await ride('scr-e', ['2027-07-02', '2027-07-03'], 10);
    await ride('scr-e', ['2027-07-20'], 2);
    const mid = eightAm('2027-07-21') + 4 * H;
    let e = await riderEarnings(pool, 'R-EARN', '2027-07', mid);
    expect(e).toMatchObject({
      month: '2027-07',
      closed: false,
      countedSeconds: 22 * H,
      hourlyPaise: 22 * PAY.perMovingHourPaise,
      pocPaise: 0,
      soldPaise: 0,
      soldAsOf: null,
      bonusPaise: 0,
      totalPaise: 22 * PAY.perMovingHourPaise,
      poc: null,
    });
    expect(e.days).toHaveLength(21);
    // Weeks from Monday: 1–4 July (Thu–Sun), then 5–11, 12–18, 19–21.
    expect(e.weeks.map((w) => [w.from, w.to, w.countedSeconds / H])).toEqual([
      ['2027-07-01', '2027-07-04', 20],
      ['2027-07-05', '2027-07-11', 0],
      ['2027-07-12', '2027-07-18', 0],
      ['2027-07-19', '2027-07-21', 2],
    ]);
    // The pay run brings the month up to date: its parts are kept beside its entry.
    await accrueRiderPay(pool, '2027-07', mid);
    e = await riderEarnings(pool, 'R-EARN', '2027-07', mid + 60);
    expect(e).toMatchObject({ soldPaise: 0, soldAsOf: mid });
    const lines = await pool.query(
      'SELECT counted_s, hourly_paise, gross_paise FROM rider_pay_lines WHERE rider_id = $1',
      ['R-EARN'],
    );
    expect(lines.rows).toEqual([
      { counted_s: String(22 * H), hourly_paise: '55000', gross_paise: '55000' },
    ]);
    await expect(pool.query('DELETE FROM rider_pay_lines')).rejects.toThrow();
    // The month closes (48 hours after it ends); an upload after that is not paid: not shown.
    await ride('scr-e', ['2027-07-25'], 3);
    const august = eightAm('2027-08-05');
    e = await riderEarnings(pool, 'R-EARN', '2027-07', august);
    expect(e).toMatchObject({ closed: true, countedSeconds: 22 * H, hourlyPaise: 55_000 });
    expect(await riderMonths(pool, 'R-EARN', august)).toEqual(['2027-08', '2027-07']);
    expect(await riderMonths(pool, 'R-NOBODY', august)).toEqual(['2027-08']);
  });

  it("the POC: each day's base, and his hours toward the founding bonus", async () => {
    // Switched on in August: the POC runs from 1 September (month 1: ₹2,000 over 30 days).
    await setBusinessMode(pool, 'poc', SUPER, 'POC starts', eightAm('2027-08-10'));
    const days = Array.from({ length: 10 }, (_, i) => `2027-09-${String(i + 2).padStart(2, '0')}`);
    await ride('scr-e', days, 12);
    const now = eightAm('2027-09-15') + 4 * H;
    const e = await riderEarnings(pool, 'R-EARN', '2027-09', now);
    const base = Array.from({ length: 15 }, (_, i) => pocDayPaise(200_000, 30, i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(e).toMatchObject({
      countedSeconds: 0,
      hourlyPaise: 0,
      pocPaise: base,
      poc: {
        countedSeconds: 120 * H,
        fromHours: 100,
        fullHours: 150,
        // 120 hours: in proportion between 100 and 150.
        bonusPaise: Math.floor((600_000 * 20) / 50),
        given: false,
      },
    });
  });
});
