import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createArea, type AreaVersion } from '../src/areas.js';
import type { Ring } from '../src/geo.js';
import {
  DEFAULT_TRACKER_RULES,
  START,
  step,
  type GpsFix,
  type Second,
  type TrackerState,
} from '../src/screen-tracker.js';

const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
const T = 1_800_000_000; // a Friday in 2027, whole seconds UTC
const LNG_PER_M = 1 / (111_195 * Math.cos((17.4 * Math.PI) / 180));
const LAT_PER_M = 1 / 111_195;

/** Runs the tracker over one entry per second (a fix, or null for no GPS). */
function run(fixes: (GpsFix | null)[], areas: AreaVersion[] = []): Second[] {
  let s: TrackerState = START;
  const out: Second[] = [];
  fixes.forEach((fix, i) => {
    const r = step(s, T + i, fix ?? undefined, areas);
    s = r.state;
    out.push(r.second);
  });
  return out;
}

/** A bike riding east at `kmh` for `seconds`, starting `startM` metres east of 78.4. */
function ride(kmh: number, seconds: number, startM = 0, t0 = 0, lat = 17.4): GpsFix[] {
  return Array.from({ length: seconds }, (_, i) => ({
    t: T + t0 + i,
    lat,
    lng: 78.4 + (startM + (kmh / 3.6) * i) * LNG_PER_M,
    accuracyM: 5,
  }));
}

/** A parked bike whose GPS wanders up to ±`noiseM` metres. */
function parked(seconds: number, atM: number, t0: number, noiseM = 4): GpsFix[] {
  return Array.from({ length: seconds }, (_, i) => ({
    t: T + t0 + i,
    lat: 17.4 + Math.sin(i * 1.7) * noiseM * LAT_PER_M,
    lng: 78.4 + (atM + Math.cos(i * 2.3) * noiseM) * LNG_PER_M,
    accuracyM: 8,
  }));
}

describe('cleaning GPS (P1.2.1)', () => {
  it('drops poor fixes and jumps; smooths the rest over 3 fixes', () => {
    const fixes: GpsFix[] = ride(20, 10);
    fixes[3] = { ...fixes[3]!, accuracyM: 80 };
    fixes[6] = { ...fixes[6]!, lat: fixes[6]!.lat + 0.01 }; // 1.1 km in a second
    const out = run(fixes);
    expect(out[3]!.fix).toBe('poor-accuracy');
    expect(out[3]!.position).toBeUndefined();
    expect(out[6]!.fix).toBe('jump');
    expect(out.filter((s) => s.fix === 'used')).toHaveLength(8);
    // Second 9: average of the good fixes at 7, 8 and 9.
    const avg = (fixes[7]!.lng + fixes[8]!.lng + fixes[9]!.lng) / 3;
    expect(out[9]!.position!.lng).toBeCloseTo(avg, 9);
  });

  it('after 5 jumps in a row it trusts the new place (the old fix was the bad one)', () => {
    const bad: GpsFix = { t: T, lat: 17.5, lng: 78.5, accuracyM: 5 };
    const real = ride(20, 10, 0, 1);
    const out = run([bad, ...real]);
    expect(out.slice(1, 5).map((s) => s.fix)).toEqual(['jump', 'jump', 'jump', 'jump']);
    expect(out[5]!.fix).toBe('used');
    expect(out[5]!.position!.lat).toBeCloseTo(17.4, 6); // not averaged with the bad fix
    expect(out.slice(6).every((s) => s.fix === 'used')).toBe(true);
  });

  it('a gap in GPS is not a jump when the speed over the gap is normal', () => {
    const fixes: (GpsFix | null)[] = ride(40, 60);
    for (let i = 20; i < 50; i++) fixes[i] = null;
    const out = run(fixes);
    expect(out[50]!.fix).toBe('used');
  });
});

describe('which area, with a 15-second hold (P1.2.2)', () => {
  const a = createArea(
    {
      areaId: 'hyd-a',
      name: 'A',
      city: 'Hyderabad',
      ring: box(17.39, 78.39, 17.41, 78.405),
      validFrom: '2026-11-01T00:00:00Z',
    },
    [],
  );
  const b = createArea(
    {
      areaId: 'hyd-b',
      name: 'B',
      city: 'Hyderabad',
      ring: box(17.39, 78.4052, 17.41, 78.42),
      validFrom: '2026-11-01T00:00:00Z',
    },
    [a],
  );

  it('switches to a new area only after 15 seconds there', () => {
    // 36 km/h = 10 m/s from 400 m east of 78.4 → crosses A's east border (≈530 m) near second 13.
    const out = run(ride(36, 80, 400), [a, b]);
    // The smoothed position enters B (border ≈ 552 m east) around second 16.
    const entered = out.findIndex((s) => (s.position?.lng ?? 0) >= 78.4052);
    const switched = out.findIndex((s) => s.place.kind !== 'inside' || s.place.areaId !== 'hyd-a');
    expect(out[0]!.place).toMatchObject({ kind: 'inside', areaId: 'hyd-a' });
    expect(entered).toBeGreaterThan(14);
    expect(switched - entered).toBe(DEFAULT_TRACKER_RULES.areaHoldSeconds - 1);
    expect(out[switched]!.place).toMatchObject({ kind: 'inside', areaId: 'hyd-b' });
  });

  it('a bike riding along the border never flickers', () => {
    // Weaves 15 m either side of the A/B border every 6 seconds.
    const border = (78.405 + 78.4052) / 2;
    const fixes: GpsFix[] = Array.from({ length: 120 }, (_, i) => ({
      t: T + i,
      lat: 17.395 + i * 5 * LAT_PER_M,
      lng: border + (Math.floor(i / 6) % 2 === 0 ? -15 : 15) * LNG_PER_M,
      accuracyM: 5,
    }));
    const out = run(fixes, [a, b]);
    const changes = out.filter(
      (s, i) => i > 0 && JSON.stringify(s.place) !== JSON.stringify(out[i - 1]!.place),
    );
    expect(changes).toHaveLength(0);
  });
});

describe('moving and the 10-minute stop rule (P1.2.3)', () => {
  it('a parked bike with wandering GPS is not moving; a bike at 20 km/h is', () => {
    expect(run(parked(120, 0, 0)).some((s) => s.moving)).toBe(false);
    expect(run(ride(20, 60)).at(-1)!.moving).toBe(true);
    expect(run(ride(4, 60)).some((s) => s.moving)).toBe(false);
  });

  it('a screen starts asleep and wakes within 10 seconds of riding', () => {
    const out = run(ride(20, 30));
    expect(out[0]!.clockRuns).toBe(false);
    const woke = out.findIndex((s) => s.clockRuns);
    expect(woke).toBeGreaterThan(0);
    expect(woke).toBeLessThanOrEqual(10);
  });

  it('the clock runs through a stop of up to 10 minutes, then pauses until the bike moves', () => {
    const rideEnd = 120 * (20 / 3.6);
    const fixes = [...ride(20, 120), ...parked(900, rideEnd, 120), ...ride(20, 60, rideEnd, 1020)];
    const out = run(fixes);
    const stopStart = out.findIndex((s, i) => i >= 120 && !s.moving);
    const sleep = out.findIndex((s) => s.standby && s.t > T + 60);
    // Asleep exactly 600 s after the stop began (the clock ran for all 600).
    expect(sleep - stopStart).toBe(DEFAULT_TRACKER_RULES.standbyAfterSeconds);
    expect(out.slice(stopStart, sleep).every((s) => s.clockRuns)).toBe(true);
    expect(out.slice(sleep, 1020).every((s) => !s.clockRuns)).toBe(true);
    const wake = out.findIndex((s, i) => i >= 1020 && s.clockRuns);
    expect(wake - 1020).toBeLessThanOrEqual(10);
  });

  it('time must move forward', () => {
    const { state } = step(START, T, undefined, []);
    expect(() => step(state, T, undefined, [])).toThrow(RangeError);
  });
});

describe('properties', () => {
  const second = fc.option(
    fc.record({
      lat: fc.double({ min: 17.3, max: 17.5, noNaN: true }),
      lng: fc.double({ min: 78.3, max: 78.5, noNaN: true }),
      accuracyM: fc.double({ min: 0, max: 200, noNaN: true }),
    }),
    { nil: null },
  );

  it('any GPS input: never throws, the clock never runs while asleep, same input → same answer', () => {
    fc.assert(
      fc.property(fc.array(second, { minLength: 1, maxLength: 400 }), (raw) => {
        const fixes = raw.map((f, i) => (f ? { ...f, t: T + i } : null));
        const one = run(fixes);
        const two = run(fixes);
        expect(two).toEqual(one);
        for (const s of one) expect(s.clockRuns).toBe(!s.standby);
        for (const s of one) if (s.moving) expect(s.standby).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
