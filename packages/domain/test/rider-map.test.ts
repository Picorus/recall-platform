// P4.4–P4.5 in the rider app: "Screen on" hours (never under the moving hours pay counts), a rider's
// own pick of days (refused when wrong, in the future, too long or too old), and the "where am I"
// map's bounded payload (a thinned route, roads cut to a small square around him).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boundRoads,
  checkDayRange,
  dailyTotals,
  distanceMeters,
  isDay,
  positionAge,
  RANGE_MAX_DAYS,
  roadsStillCover,
  segmentHitsBox,
  screenOnByDay,
  thinRoute,
  type MapRoad,
  type MinuteSummary,
} from '../src/index.js';

/** India 08:00 on a day, in UTC seconds. */
const eightAm = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;

const minute = (t: number, tracked: number, clock: number, pay = clock): MinuteSummary => ({
  kind: 'minute',
  minute: t,
  secondsAt: tracked > 0 ? { 'inside:hyd-madhapur@1': tracked } : {},
  clockSeconds: clock,
  clockAt: clock > 0 ? { 'inside:hyd-madhapur@1': clock } : {},
  payClockSeconds: pay,
  movingSeconds: clock,
  distanceM: clock * 5,
  plays: 0,
  people: 0,
});

describe('screen on hours (P4.4)', () => {
  it('every reported second of the business day, standing or moving; not the night', () => {
    const d = '2027-07-19';
    const minutes = [
      minute(eightAm(d), 60, 60), // moving
      minute(eightAm(d) + 60, 60, 0), // standing, screen on
      minute(eightAm(d) + 120, 30, 0), // switched off half-way
      minute(eightAm(d) + 17 * 3600 + 59 * 60, 60, 60), // 01:59, still the 19th
      minute(eightAm(d) + 18 * 3600, 60, 60), // 02:00: outside business hours
    ];
    expect(screenOnByDay(minutes).get(d)).toBe(60 + 60 + 30 + 60);
    expect(screenOnByDay(minutes).size).toBe(1);
    // An old box that sent no places still counts its clock seconds.
    expect(screenOnByDay([minute(eightAm(d), 0, 45)]).get(d)).toBe(45);
    // A minute sent twice (a restart) holds at most 60 seconds.
    expect(screenOnByDay([minute(eightAm(d), 50, 0), minute(eightAm(d), 50, 0)]).get(d)).toBe(60);
  });

  it('property: screen on is never under the counted moving time, each day', () => {
    const t0 = eightAm('2027-07-19');
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            m: fc.integer({ min: 0, max: 3 * 24 * 60 }),
            tracked: fc.integer({ min: 0, max: 60 }),
            clock: fc.integer({ min: 0, max: 60 }),
            pay: fc.integer({ min: 0, max: 60 }),
          }),
          { maxLength: 300 },
        ),
        (rows) => {
          const minutes = rows.map((r) =>
            minute(t0 + r.m * 60, r.tracked, r.clock, Math.min(r.pay, r.clock)),
          );
          const on = screenOnByDay(minutes);
          for (const [day, t] of dailyTotals(minutes)) {
            expect(on.get(day) ?? 0).toBeGreaterThanOrEqual(t.countedSeconds);
            expect(on.get(day) ?? 0).toBeGreaterThanOrEqual(t.clockSeconds);
          }
          for (const s of on.values()) expect(s).toBeLessThanOrEqual(18 * 3600);
        },
      ),
    );
  });
});

describe("a rider's own pick of days (P4.5)", () => {
  const today = '2027-08-23';
  it('real dates, in order, not in the future, at most 92 days, not too old', () => {
    expect(checkDayRange('2027-08-01', today, today)).toEqual({ ok: true });
    expect(checkDayRange(today, today, today)).toEqual({ ok: true });
    expect(checkDayRange('2027-02-30', today, today)).toEqual({ ok: false, why: 'bad-date' });
    expect(checkDayRange('2027-8-1', today, today)).toEqual({ ok: false, why: 'bad-date' });
    expect(checkDayRange("2027-08-01' OR 1=1", today, today)).toMatchObject({ why: 'bad-date' });
    expect(checkDayRange('2027-08-10', '2027-08-09', today)).toEqual({
      ok: false,
      why: 'backwards',
    });
    expect(checkDayRange('2027-08-20', '2027-08-24', today)).toEqual({ ok: false, why: 'future' });
    // 92 days is fine, 93 is not.
    expect(checkDayRange('2027-05-24', today, today)).toEqual({ ok: true });
    expect(checkDayRange('2027-05-23', today, today)).toEqual({ ok: false, why: 'too-long' });
    expect(checkDayRange('2025-01-01', '2025-01-31', today)).toEqual({ ok: false, why: 'too-old' });
    expect(isDay('2028-02-29')).toBe(true);
    expect(isDay('2027-02-29')).toBe(false);
  });

  it('property: an accepted pick is never longer than 92 days nor past today', () => {
    const day = fc
      .integer({ min: 0, max: 900 })
      .map((n) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, day, day, (from, to, now) => {
        const r = checkDayRange(from, to, now);
        if (!r.ok) return;
        expect(to <= now && from <= to).toBe(true);
        expect((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1).toBeLessThanOrEqual(
          RANGE_MAX_DAYS,
        );
      }),
    );
  });
});

describe('where am I (P4.4)', () => {
  it('a position is live, recent or old by its age', () => {
    expect(positionAge(1000, 1000 - 60)).toBe('live');
    expect(positionAge(10_000, 10_000 - 600)).toBe('recent');
    expect(positionAge(10_000, 10_000 - 3600)).toBe('old');
  });

  it('roads are sent again only once he has moved 300 m', () => {
    const a = { lat: 17.4474, lng: 78.3762 };
    expect(roadsStillCover(a, { lat: 17.4484, lng: 78.3762 })).toBe(true); // 111 m
    expect(roadsStillCover(a, { lat: 17.4504, lng: 78.3762 })).toBe(false); // 334 m
  });

  it('a route is thinned evenly, keeping its first and last point', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const thin = thinRoute(pts, 400);
    expect(thin).toHaveLength(400);
    expect(thin[0]).toBe(0);
    expect(thin.at(-1)).toBe(999);
    expect(thin).toEqual([...thin].sort((a, b) => a - b));
    expect(thinRoute([1, 2, 3], 400)).toEqual([1, 2, 3]);
    expect(thinRoute(pts, 1)).toEqual([999]);
  });

  it('roads are cut to the square around him and bounded, whatever the provider sends', () => {
    const centre = { lat: 17.4474, lng: 78.3762 };
    // A long road through him, east to west, and a far one.
    const through: MapRoad = {
      main: true,
      points: Array.from({ length: 101 }, (_, i) => [17.4474, 78.3262 + i * 0.001] as const),
    };
    const far: MapRoad = {
      main: false,
      points: [
        [17.6, 78.6],
        [17.61, 78.61],
      ],
    };
    const out = boundRoads([far, through], centre, 900);
    expect(out).toHaveLength(1);
    const kept = out[0]?.points ?? [];
    // About 1.8 km of it: the points inside, plus one beyond each edge.
    expect(kept.length).toBeGreaterThanOrEqual(17);
    expect(kept.length).toBeLessThanOrEqual(21);
    for (const [lat, lng] of kept)
      expect(distanceMeters(centre, { lat, lng })).toBeLessThan(900 * 1.5 + 120);

    // A long straight road given only by its two far ends still crosses the map.
    const straight: MapRoad = {
      main: true,
      points: [
        [17.4474, 78.3],
        [17.4474, 78.45],
      ],
    };
    expect(boundRoads([straight], centre, 900)).toEqual([straight]);
    expect(segmentHitsBox(-5, 0, 5, 0, -1, -1, 1, 1)).toBe(true);
    expect(segmentHitsBox(-5, 2, 5, 2, -1, -1, 1, 1)).toBe(false);
    expect(segmentHitsBox(-5, -5, 5, 5, -1, -1, 1, 1)).toBe(true);
    expect(segmentHitsBox(2, -5, 5, 5, -1, -1, 1, 1)).toBe(false);
    expect(segmentHitsBox(0, 0, 0.5, 0.5, -1, -1, 1, 1)).toBe(true);

    // Thousands of junk roads: never more than the limits.
    const many: MapRoad[] = Array.from({ length: 3000 }, (_, i) => ({
      main: i % 7 === 0,
      points: Array.from(
        { length: 10 },
        (_, j) => [17.44 + (i % 50) * 0.0003, 78.37 + j * 0.0002 + (i % 3) * 0.0001] as const,
      ),
    }));
    const bounded = boundRoads(many, centre, 900, { maxRoadLines: 400, maxRoadPoints: 5000 });
    expect(bounded.length).toBeLessThanOrEqual(400);
    expect(bounded.reduce((n, r) => n + r.points.length, 0)).toBeLessThanOrEqual(5000);
    // Garbage points are dropped, coordinates rounded to about a metre.
    const odd = boundRoads(
      [
        {
          main: false,
          points: [
            [17.44741234, 78.37621234],
            [Number.NaN, 1],
            [17.4475, 78.3763],
          ],
        },
      ],
      centre,
      900,
    );
    expect(odd).toEqual([
      {
        main: false,
        points: [
          [17.44741, 78.37621],
          [17.4475, 78.3763],
        ],
      },
    ]);
  });
});
