// Shared test cases for the screen logic (DECISIONS, 22 Oct 2026). The Kotlin player (P2) must
// produce exactly `expected` from `input`. Regenerate after a deliberate change with:
//   UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchAreas } from '../src/launch-areas.js';
import {
  addSecond,
  EMPTY_MINUTE,
  flushMinute,
  placeKey,
  type MinuteBuilder,
  type Report,
} from '../src/screen-reports.js';
import {
  DEFAULT_TRACKER_RULES,
  START,
  step,
  type GpsFix,
  type TrackerState,
} from '../src/screen-tracker.js';

const FILE = new URL('../test-vectors/screen-tracker.json', import.meta.url);
const T = 1_800_000_000;
const LNG_PER_M = 1 / (111_195 * Math.cos((17.447 * Math.PI) / 180));

/**
 * Hitech City → Madhapur at 25 km/h with: a poor fix, a far jump, a jump just over and a move just
 * under 150 km/h, a steady 5-fix jump run (reset), a 40 s tunnel, an 11-minute stop with a 20 m push
 * in the middle, then riding on.
 */
function scenario(): (GpsFix | null)[] {
  const out: (GpsFix | null)[] = [];
  let m = 0;
  const at = (i: number, metres: number, acc = 5, lat = 17.447): GpsFix => ({
    t: T + i,
    lat,
    lng: 78.378 + metres * LNG_PER_M,
    accuracyM: acc,
  });
  for (let i = 0; i < 1300; i++) {
    const riding = i < 240 || i >= 1000;
    if (riding) m += 25 / 3.6;
    if (i >= 700 && i < 708) m += 2.5; // the push while parked
    if (i === 30) out.push(at(i, m, 90));
    else if (i === 60) out.push(at(i, m, 5, 17.46));
    else if (i === 70)
      out.push(at(i, m + 42.5)); // 42.5 m + 6.9 m in 1 s ≈ 178 km/h: a jump
    else if (i === 80)
      out.push(at(i, m + 34)); // ≈ 147 km/h from the last good fix: used
    else if (i >= 180 && i < 185)
      out.push(at(i, m + 2000 + (i - 180) * 5)); // steady run → reset
    else if (i >= 100 && i < 140) out.push(null);
    else out.push(at(i, riding ? m : m + Math.sin(i) * 3, riding ? 5 : 9));
  }
  return out;
}

const round7 = (x: number) => Math.round(x * 1e7) / 1e7;

function expected(input: (GpsFix | null)[]) {
  const areas = launchAreas();
  let s: TrackerState = START;
  let b: MinuteBuilder = EMPTY_MINUTE;
  const seconds: unknown[] = [];
  const reports: Report[] = [];
  input.forEach((fix, i) => {
    const r = step(s, T + i, fix ?? undefined, areas);
    s = r.state;
    const sec = r.second;
    seconds.push({
      t: sec.t,
      fix: sec.fix,
      lat: sec.position ? round7(sec.position.lat) : null,
      lng: sec.position ? round7(sec.position.lng) : null,
      place: placeKey(sec.place),
      moving: sec.moving,
      standby: sec.standby,
      clockRuns: sec.clockRuns,
    });
    const a = addSecond(b, sec);
    b = a.builder;
    reports.push(...a.reports);
  });
  reports.push(...flushMinute(b));
  return { seconds, minutes: reports.filter((r) => r.kind === 'minute') };
}

const NOTES = [
  'Distances: haversine on a sphere of radius 6,371,008.8 m.',
  'Speed between two fixes: distance / max(1, seconds apart) × 3.6.',
  'Smoothed position: plain average of lat and of lng over the last `smoothOver` used fixes.',
  'Window speeds: start-to-end distance over the smoothed track inside the window; needs at least half the window.',
  'Positions in `seconds` are rounded to 7 decimals (about 1 cm); compare with that tolerance.',
];

describe('shared screen test cases', () => {
  const input = scenario();
  const vectors = {
    notes: NOTES,
    rules: DEFAULT_TRACKER_RULES,
    areas: launchAreas(),
    input,
    expected: expected(input),
  };
  const text = `${JSON.stringify(vectors)}\n`;
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE)) writeFileSync(FILE, text);

  it('are up to date (UPDATE_VECTORS=1 to regenerate after a deliberate change)', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('cover every behaviour the player must copy', () => {
    const e = vectors.expected.seconds as {
      fix: string;
      place: string;
      moving: boolean;
      standby: boolean;
      clockRuns: boolean;
    }[];
    const kinds = new Set(e.map((x) => x.fix));
    for (const k of ['used', 'reset', 'no-fix', 'poor-accuracy', 'jump'])
      expect(kinds.has(k)).toBe(true);
    expect(e[70]?.fix).toBe('jump');
    expect(e[80]?.fix).toBe('used');
    expect(e[184]?.fix).toBe('reset');
    expect(e.some((x) => x.place.startsWith('inside:hyd-hitech-city'))).toBe(true);
    expect(e.some((x) => x.place.startsWith('inside:hyd-madhapur'))).toBe(true);
    const slept = e.findIndex((x, i) => i > 300 && x.standby);
    expect(slept).toBeGreaterThan(800);
    // The push at 700 s happens before standby, the clock keeps its original stop.
    expect(e.slice(slept, 1000).every((x) => x.standby)).toBe(true);
    expect(vectors.expected.minutes.length).toBeGreaterThan(20);
  });
});
