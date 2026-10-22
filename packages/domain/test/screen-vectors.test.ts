// Shared test cases for the screen logic (DECISIONS, 22 Oct 2026). The Kotlin player (P2) must
// produce exactly `expected` from `input`. Regenerate after a deliberate change with:
//   UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchAreas } from '../src/launch-areas.js';
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

/** Hitech City → Madhapur at 25 km/h, a poor fix, a jump, a 40 s tunnel, an 11-minute stop, ride on. */
function scenario(): (GpsFix | null)[] {
  const out: (GpsFix | null)[] = [];
  let m = 0;
  const at = (i: number, metres: number, acc = 5): GpsFix => ({
    t: T + i,
    lat: 17.447,
    lng: 78.378 + metres * LNG_PER_M,
    accuracyM: acc,
  });
  for (let i = 0; i < 1200; i++) {
    const riding = i < 240 || i >= 940;
    if (riding) m += 25 / 3.6;
    if (i === 30) out.push(at(i, m, 90));
    else if (i === 60) out.push({ ...at(i, m), lat: 17.46 });
    else if (i >= 100 && i < 140) out.push(null);
    else out.push(at(i, riding ? m : m + Math.sin(i) * 3, riding ? 5 : 9));
  }
  return out;
}

function expected(input: (GpsFix | null)[]) {
  const areas = launchAreas();
  let s: TrackerState = START;
  return input.map((fix, i) => {
    const r = step(s, T + i, fix ?? undefined, areas);
    s = r.state;
    const p = r.second.place;
    return {
      t: r.second.t,
      fix: r.second.fix,
      place: p.kind === 'outside' ? 'outside' : `${p.kind}:${p.areaId}@${p.version}`,
      moving: r.second.moving,
      standby: r.second.standby,
    };
  });
}

describe('shared screen test cases', () => {
  const input = scenario();
  const vectors = {
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
    const e = vectors.expected;
    const kinds = new Set(e.map((s) => s.fix));
    for (const k of ['used', 'no-fix', 'poor-accuracy', 'jump'])
      expect(kinds.has(k as never)).toBe(true);
    expect(e.some((s) => s.place.startsWith('inside:hyd-hitech-city'))).toBe(true);
    expect(e.some((s) => s.place.startsWith('inside:hyd-madhapur'))).toBe(true);
    expect(e.some((s) => s.standby) && e.some((s) => s.moving)).toBe(true);
    const slept = e.findIndex((s, i) => i > 300 && s.standby);
    expect(slept).toBeGreaterThan(800);
    expect(e.slice(slept, 940).every((s) => s.standby)).toBe(true);
  });
});
