// P4.4: the rider app's Today page: his screen now, his counted moving hours today and this week
// (only while he rode the screen), and what they earned by his pay rules, regular and POC.
import { fakeDeviceCa } from '@recall/adapters';
import { DEFAULT_RIDER_PAY_RULES as PAY, pocDayPaise, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savePriceBook } from '../../src/bookings.js';
import { setBusinessMode } from '../../src/business-mode.js';
import { assignScreen } from '../../src/rider-pay.js';
import { riderToday } from '../../src/rider-today.js';
import { createRider } from '../../src/riders.js';
import { enrolScreen, fitScreen } from '../../src/screens.js';
import { boxRequest, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const PLACE = 'inside:hyd-madhapur@1';
const SUPER = { id: 'prateek', role: 'super-admin' } as const;

/** India 08:00 on a day, in UTC seconds. */
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;

/** A screen's minute summaries for `minutes` minutes from `from` (as the screen would send). */
async function ride(screen: string, from: number, minutes: number) {
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screen,
  ]);
  const r = await pool.query<{ n: string }>(
    'SELECT coalesce(max(seq), 0) AS n FROM screen_reports WHERE screen_id = $1',
    [screen],
  );
  const seq = Number(r.rows[0]?.n ?? 0);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
     SELECT $1, $2 + g, 'minute', to_timestamp($3 + (g - 1) * 60), '{}'::jsonb
       FROM generate_series(1, $4) g`,
    [screen, seq, from, minutes],
  );
  await pool.query(
    `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
       distance_m, plays, people, seconds_at, clock_at)
     SELECT $1, to_timestamp($3 + (g - 1) * 60), $2 + g, 60, 60, 60, 400, 0, 0, $5, $5
       FROM generate_series(1, $4) g`,
    [screen, seq, from, minutes, JSON.stringify({ [PLACE]: 60 })],
  );
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
}, 60_000);
afterAll(async () => db.drop());

describe("the rider app's Today page (P4.4)", () => {
  it('regular business: his hours today and this week, only while he rode, at ₹25 an hour', async () => {
    // Monday 19 July 2027. R-ONE rides scr-t from Sunday; R-TWO takes it from Wednesday 08:00.
    await assignScreen(pool, 'scr-t', 'R-ONE', eightAm('2027-07-18'), 'fitter');
    await assignScreen(pool, 'scr-t', 'R-TWO', eightAm('2027-07-21'), 'fitter');
    await ride('scr-t', eightAm('2027-07-18'), 60); // last week: not this week's
    await ride('scr-t', eightAm('2027-07-19'), 120);
    await ride('scr-t', eightAm('2027-07-20') + 3600, 180);
    await ride('scr-t', eightAm('2027-07-21'), 90);
    // Tuesday 22:00 India time.
    const tue = eightAm('2027-07-20') + 14 * 3600;
    const one = await riderToday(pool, 'R-ONE', tue);
    expect(one).toMatchObject({
      screen: null,
      mode: 'regular',
      today: {
        day: '2027-07-20',
        countedSeconds: 3 * 3600,
        earnedPaise: 3 * PAY.perMovingHourPaise,
      },
      week: { countedSeconds: 5 * 3600, earnedPaise: 5 * PAY.perMovingHourPaise },
      perMovingHourPaise: 2_500,
      monthlyCapHours: 260,
    });
    expect(one.week.days.map((d) => d.day)).toEqual(['2027-07-19', '2027-07-20']);
    // Monday 01:00 (still Sunday's business day): last week, Sunday's hour today.
    const sunNight = eightAm('2027-07-18') + 17 * 3600;
    expect((await riderToday(pool, 'R-ONE', sunNight)).today).toMatchObject({
      day: '2027-07-18',
      countedSeconds: 3600,
    });
    // Wednesday: the screen is R-TWO's; R-ONE's day is empty, the week stays his.
    const wed = eightAm('2027-07-21') + 10 * 3600;
    expect((await riderToday(pool, 'R-ONE', wed)).today.countedSeconds).toBe(0);
    expect((await riderToday(pool, 'R-ONE', wed)).week.countedSeconds).toBe(5 * 3600);
    expect((await riderToday(pool, 'R-TWO', wed)).today).toMatchObject({
      countedSeconds: 90 * 60,
      earnedPaise: 3_750,
    });
  });

  it('his screen now: on and moving, battery and signal; off once not heard from', async () => {
    const now = eightAm('2027-07-22') + 3 * 3600;
    const riderId = await createRider(
      pool,
      {
        details: {
          name: 'Ravi Kumar',
          phone: '+919811177777',
          bikePlate: 'TS09EA7777',
          rides: '',
          apps: [],
        },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      now - 86_400,
    );
    await pool.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       VALUES ($1, 2, 'approved', 'all checked', 'Omar', to_timestamp($2))`,
      [riderId, now - 80_000],
    );
    const box = await enrolScreen(
      pool,
      fakeDeviceCa(),
      boxRequest('RK-TODAY', now - 86_400),
      'w',
      now - 86_400,
    );
    await fitScreen(pool, { qr: box.qr, plate: 'TS09EA7777', riderId }, 'fitter', now - 7200);
    await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      box.screenId,
    ]);
    const t = now - 60;
    await pool.query(
      `INSERT INTO screen_reports (screen_id, seq, kind, made_at, received_at, body) VALUES
         ($1, 1, 'live', to_timestamp($2), to_timestamp($2), '{"lat":17.44,"lng":78.39,"moving":true}'),
         ($1, 2, 'health', to_timestamp($2), to_timestamp($2), '{}')`,
      [box.screenId, t],
    );
    await pool.query(
      `INSERT INTO screen_health (screen_id, t, seq, app, up_s, battery_pct, charging, free_mb,
         signal_dbm, clock_disagree, spots_not_counted, plays_not_stored, messages_refused,
         gps_missed_seconds, ads_missing)
       VALUES ($1, to_timestamp($2), 2, '1.0.0', 100, 64, false, 900, -92, false, 0, 0, 0, 0, 0)`,
      [box.screenId, t],
    );
    expect((await riderToday(pool, riderId, now)).screen).toEqual({
      screenId: box.screenId,
      state: 'moving',
      lastHeard: t,
      batteryPct: 64,
      charging: false,
      signalBars: 3,
    });
    expect((await riderToday(pool, riderId, now + 3600)).screen?.state).toBe('offline');
  });

  it("POC: each day he held a screen earns the month's base spread over its days", async () => {
    // Switched on in July: the POC counts from 1 August (month 1, ₹2,000).
    await setBusinessMode(pool, 'poc', SUPER, 'POC starts', eightAm('2027-07-26'));
    await assignScreen(pool, 'scr-p', 'R-POC', eightAm('2027-08-03'), 'fitter');
    await ride('scr-p', eightAm('2027-08-03'), 30);
    // Wednesday 4 August, midday: Tuesday held (its base), Wednesday held too.
    const wed = eightAm('2027-08-04') + 4 * 3600;
    const p = await riderToday(pool, 'R-POC', wed);
    const day = (d: number) => pocDayPaise(PAY.pocBasesPaise[0] ?? 0, 31, d);
    expect(p.mode).toBe('poc');
    expect(p.week.days).toEqual([
      { day: '2027-08-02', countedSeconds: 0, earnedPaise: 0 },
      { day: '2027-08-03', countedSeconds: 1800, earnedPaise: day(3) },
      { day: '2027-08-04', countedSeconds: 0, earnedPaise: day(4) },
    ]);
    expect(p.week.earnedPaise).toBe(day(3) + day(4));
  });
});
