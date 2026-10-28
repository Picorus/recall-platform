// P4.4–P4.5: the rider app's days he picks (screen-on and moving hours, earnings by day, as Today
// and the month's page work them out) and its "where am I" map (his screen's last position while it
// was his, his route today, the street and the roads around him, bounded). Another rider's minutes
// or positions are never his.
import { fakeMaps, type MapsAdapter } from '@recall/adapters';
import { DEFAULT_RIDER_PAY_RULES as PAY, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { savePriceBook } from '../../src/bookings.js';
import { riderEarnings } from '../../src/rider-earnings.js';
import { assignScreen } from '../../src/rider-pay.js';
import { riderRange, riderToday } from '../../src/rider-today.js';
import { riderWhere } from '../../src/rider-where.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const PLACE = 'inside:hyd-madhapur@1';
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;
const H = 3600;

async function nextSeq(screen: string) {
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screen,
  ]);
  const r = await pool.query<{ n: string }>(
    'SELECT coalesce(max(seq), 0) AS n FROM screen_reports WHERE screen_id = $1',
    [screen],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** `minutes` minute summaries from `from`: moving (clock runs) or standing with the screen on. */
async function minutes(screen: string, from: number, n: number, moving: boolean) {
  const seq = await nextSeq(screen);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
     SELECT $1, $2 + g, 'minute', to_timestamp($3 + (g - 1) * 60), '{}'::jsonb
       FROM generate_series(1, $4) g`,
    [screen, seq, from, n],
  );
  const clock = moving ? 60 : 0;
  await pool.query(
    `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
       distance_m, plays, people, seconds_at, clock_at)
     SELECT $1, to_timestamp($3 + (g - 1) * 60), $2 + g, $5, $5, $5, 400, 0, 0, $6, $7
       FROM generate_series(1, $4) g`,
    [
      screen,
      seq,
      from,
      n,
      clock,
      JSON.stringify({ [PLACE]: 60 }),
      JSON.stringify(moving ? { [PLACE]: 60 } : {}),
    ],
  );
}

/** Live positions every 30 s from `from`, walking east from a point. */
async function lives(screen: string, from: number, n: number, lat: number, lng: number) {
  const seq = await nextSeq(screen);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, received_at, body)
     SELECT $1, $2 + g, 'live', to_timestamp($3 + (g - 1) * 30), to_timestamp($3 + (g - 1) * 30),
            jsonb_build_object('kind', 'live', 'lat', $5::float8, 'lng', $6::float8 + g * 0.00002,
                               'moving', true, 'place', 'outside')
       FROM generate_series(1, $4) g`,
    [screen, seq, from, n, lat, lng],
  );
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
}, 60_000);
afterAll(async () => db.drop());

describe('days he picks (P4.5)', () => {
  it('screen-on and moving hours and earnings by day; only while he rode; across months', async () => {
    // R-AAA rides scr-r from 29 July; R-BBB takes it on 3 August at 08:00.
    await assignScreen(pool, 'scr-r', 'R-AAA', eightAm('2027-07-29'), 'fitter');
    await assignScreen(pool, 'scr-r', 'R-BBB', eightAm('2027-08-03'), 'fitter');
    for (const day of ['2027-07-30', '2027-07-31', '2027-08-01', '2027-08-02', '2027-08-03']) {
      await minutes('scr-r', eightAm(day), 2 * 60, true); // 2 h moving
      await minutes('scr-r', eightAm(day) + 2 * H, 60, false); // 1 h standing, screen on
    }
    // The screen standing at night (03:00): neither screen-on nor moving.
    await minutes('scr-r', eightAm('2027-07-31') - 5 * H, 30, false);
    const now = eightAm('2027-08-05') + 2 * H;
    const r = await riderRange(pool, 'R-AAA', '2027-07-30', '2027-08-05', now);
    expect(r.days.map((d) => d.day)).toEqual([
      '2027-07-30',
      '2027-07-31',
      '2027-08-01',
      '2027-08-02',
      '2027-08-03',
      '2027-08-04',
      '2027-08-05',
    ]);
    expect(r.days[0]).toEqual({
      day: '2027-07-30',
      countedSeconds: 2 * H,
      screenOnSeconds: 3 * H,
      earnedPaise: 2 * PAY.perMovingHourPaise,
    });
    // 3 August is R-BBB's.
    expect(r.days[4]).toMatchObject({ countedSeconds: 0, screenOnSeconds: 0, earnedPaise: 0 });
    expect(r).toMatchObject({
      countedSeconds: 8 * H,
      screenOnSeconds: 12 * H,
      earnedPaise: 8 * PAY.perMovingHourPaise,
      perMovingHourPaise: PAY.perMovingHourPaise,
    });
    for (const d of r.days) expect(d.screenOnSeconds).toBeGreaterThanOrEqual(d.countedSeconds);
    // The same days as the month pages say.
    const july = await riderEarnings(pool, 'R-AAA', '2027-07', now);
    const aug = await riderEarnings(pool, 'R-AAA', '2027-08', now);
    const byMonth = new Map([...july.days, ...aug.days].map((d) => [d.day, d.earnedPaise]));
    for (const d of r.days) expect(d.earnedPaise).toBe(byMonth.get(d.day));
    // R-BBB sees only his own day.
    const b = await riderRange(pool, 'R-BBB', '2027-07-30', '2027-08-05', now);
    expect(b).toMatchObject({ countedSeconds: 2 * H, screenOnSeconds: 3 * H });
    // Today's page says the same for today.
    const t = await riderToday(pool, 'R-BBB', eightAm('2027-08-03') + 4 * H);
    expect(t.today).toMatchObject({ countedSeconds: 2 * H, screenOnSeconds: 3 * H });
    expect(t.week.screenOnSeconds).toBe(3 * H);
    // Refused: in the future, backwards, too long.
    await expect(riderRange(pool, 'R-AAA', '2027-08-01', '2027-08-06', now)).rejects.toThrow(
      /future/,
    );
    await expect(riderRange(pool, 'R-AAA', '2027-08-02', '2027-08-01', now)).rejects.toThrow(
      /backwards/,
    );
    await expect(riderRange(pool, 'R-AAA', '2027-04-01', '2027-08-05', now)).rejects.toThrow(
      /too-long/,
    );
  });
});

describe('where am I (P4.4)', () => {
  it("his screen's last position while it was his, his route today, the street and roads", async () => {
    const day = '2027-09-14';
    const swap = eightAm(day) + 2 * H; // 10:00: the screen goes from R-OLD to R-NEW
    await assignScreen(pool, 'scr-w', 'R-OLD', eightAm(day) - 5 * 86_400, 'fitter');
    await assignScreen(pool, 'scr-w', 'R-NEW', swap, 'fitter');
    // R-OLD's morning far away (Banjara Hills); R-NEW's ride in Madhapur from 10:00.
    await lives('scr-w', eightAm(day), 200, 17.412, 78.43);
    await lives('scr-w', swap, 600, 17.4483, 78.3815);
    // Another rider's screen nearby, the same minutes: never his.
    await assignScreen(pool, 'scr-x', 'R-OTHER', eightAm(day) - 86_400, 'fitter');
    await lives('scr-x', swap, 50, 17.449, 78.382);

    const now = swap + 600 * 30 + 30;
    const maps = fakeMaps();
    const w = await riderWhere(pool, maps, 'R-NEW', now);
    expect(w.position).toMatchObject({ t: swap + 599 * 30, moving: true, age: 'live' });
    expect(w.position?.lat).toBeCloseTo(17.4483, 5);
    expect(w.street).toBe('Madhapur Main Road');
    // The route: his 600 positions thinned to 400, all his (none of R-OLD's or R-OTHER's).
    expect(w.route).toHaveLength(400);
    for (const [lat] of w.route) expect(lat).toBeCloseTo(17.4483, 4);
    expect(w.centre).toEqual({ lat: w.position?.lat, lng: w.position?.lng });
    // Roads: bounded, near him.
    const roads = w.roads ?? [];
    expect(roads.length).toBeGreaterThan(5);
    expect(roads.length).toBeLessThanOrEqual(800);
    expect(roads.reduce((n, r) => n + r.points.length, 0)).toBeLessThanOrEqual(5000);
    for (const r of roads)
      for (const [lat, lng] of r.points) {
        expect(Math.abs(lat - 17.4483)).toBeLessThan(0.02);
        expect(Math.abs(lng - (w.centre?.lng ?? 0))).toBeLessThan(0.02);
      }
    expect(JSON.stringify(w).length).toBeLessThan(60_000);
    // Asked again nearby: no roads (the phone has them).
    expect((await riderWhere(pool, maps, 'R-NEW', now, { roads: false })).roads).toBeNull();

    // R-OLD: his last position is from before the swap, and old by now; his route today is his
    // morning only.
    const old = await riderWhere(pool, maps, 'R-OLD', now);
    expect(old.position).toMatchObject({ t: eightAm(day) + 199 * 30, age: 'old' });
    expect(old.route).toHaveLength(200);
    for (const [lat] of old.route) expect(lat).toBeCloseTo(17.412, 4);

    // No maps set up: position and route, no street, no roads.
    const plain = await riderWhere(pool, undefined, 'R-NEW', now);
    expect(plain).toMatchObject({ street: null, roads: null });
    expect(plain.position).not.toBeNull();

    // A provider that sends far too much is cut to the bounds; one that fails gives no roads.
    const flood: MapsAdapter = {
      streetAt: () => Promise.reject(new Error('down')),
      roadsNear: (lat, lng) =>
        Promise.resolve(
          Array.from({ length: 5000 }, (_, i) => ({
            main: false,
            points: Array.from(
              { length: 20 },
              (_, j) => [lat + (i % 100) * 0.0001, lng - 0.05 + j * 0.005] as const,
            ),
          })),
        ),
    };
    const cut = await riderWhere(pool, flood, 'R-NEW', now);
    expect(cut.street).toBeNull();
    expect((cut.roads ?? []).length).toBeLessThanOrEqual(800);
    expect((cut.roads ?? []).reduce((n, r) => n + r.points.length, 0)).toBeLessThanOrEqual(5000);
    const failing: MapsAdapter = {
      streetAt: () => Promise.resolve(undefined),
      roadsNear: () => Promise.reject(new Error('down')),
    };
    expect((await riderWhere(pool, failing, 'R-NEW', now)).roads).toEqual([]);

    // A rider with no screen, or none heard from in 24 hours: nothing to show.
    expect(await riderWhere(pool, maps, 'R-NOBODY', now)).toMatchObject({
      position: null,
      route: [],
      centre: null,
      roads: null,
      street: null,
    });
    const tomorrow = await riderWhere(pool, maps, 'R-NEW', now + 30 * H);
    expect(tomorrow).toMatchObject({ position: null, route: [], centre: null });
  });
});
