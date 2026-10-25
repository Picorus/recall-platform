// P1.2.1–P1.2.3: what the screen works out every second from GPS: a cleaned position, which area it is
// in, whether the bike is moving, and whether the moving-hour clock runs.
//
// This is the reference version of the player's logic (DECISIONS, 22 Oct 2026). It is a pure function
// of its inputs so the simulator, the cloud's re-checks and the Kotlin player give identical answers
// for the same seconds.
import { locate, type AreaVersion, type Place } from './areas.js';
import { distanceMeters, type LatLng } from './geo.js';

/** Thresholds. Settings, not hard-coded rules: the cloud sends them to every screen. */
export interface TrackerRules {
  /** P1.2.1: drop fixes the phone chip itself rates worse than this, in metres. */
  readonly maxAccuracyM: number;
  /** P1.2.1: drop a fix that would mean moving faster than this from the last good one. */
  readonly maxSpeedKmh: number;
  /** After this many jumps in a row, trust the new position (the old one was the bad one). */
  readonly jumpResetAfter: number;
  /** P1.2.1: smoothing: average of the last N good fixes. */
  readonly smoothOver: number;
  /** P1.2.2: a new area must hold this many seconds before the screen switches to it. */
  readonly areaHoldSeconds: number;
  /** P1.2.3: moving = above this speed… */
  readonly movingKmh: number;
  /** …on average (start-to-end distance) over this many seconds. */
  readonly movingWindowSeconds: number;
  /** In standby, wake when the bike covers `movingKmh` over this shorter window. */
  readonly wakeWindowSeconds: number;
  /** P1.2.3, the 10-minute stop rule: standing still longer than this pauses the clock. */
  readonly standbyAfterSeconds: number;
}

export const DEFAULT_TRACKER_RULES: TrackerRules = {
  maxAccuracyM: 50,
  maxSpeedKmh: 150,
  jumpResetAfter: 5,
  smoothOver: 3,
  areaHoldSeconds: 15,
  movingKmh: 5,
  movingWindowSeconds: 30,
  wakeWindowSeconds: 10,
  standbyAfterSeconds: 600,
};

/** One GPS reading as the chip reports it. `t` is whole seconds since 1970, UTC. */
export interface GpsFix {
  readonly t: number;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
}

/**
 * `used`: a normal good fix. `reset`: a run of jumps long and steady enough to trust (the earlier
 * position was the bad one); distance is not counted across it. The rest are dropped.
 */
export type FixVerdict = 'used' | 'reset' | 'no-fix' | 'poor-accuracy' | 'jump';

interface TimedPoint extends LatLng {
  readonly t: number;
}

export interface TrackerState {
  readonly t: number | undefined;
  /** Last fix accepted as real (not smoothed). */
  readonly lastGood: TimedPoint | undefined;
  /** Fixes dropped as jumps in a row, oldest first, while they agree with each other. */
  readonly jumps: readonly TimedPoint[];
  /** Last `smoothOver` good fixes, oldest first. */
  readonly recent: readonly TimedPoint[];
  /** Smoothed positions over the moving window, oldest first. */
  readonly track: readonly TimedPoint[];
  /** The area the screen is acting on. */
  readonly place: Place;
  /** A different area seen, and on how many seconds with GPS, while it waits out the hold. */
  readonly pending: { readonly place: Place; readonly seen: number } | undefined;
  readonly moving: boolean;
  /** First second of the current stop (undefined while moving). */
  readonly stillSince: number | undefined;
  readonly standby: boolean;
}

export const START: TrackerState = {
  t: undefined,
  lastGood: undefined,
  jumps: [],
  recent: [],
  track: [],
  place: { kind: 'outside' },
  pending: undefined,
  moving: false,
  stillSince: undefined,
  standby: true,
};

/** What the screen decided for one second. */
export interface Second {
  readonly t: number;
  readonly fix: FixVerdict;
  readonly position: LatLng | undefined;
  readonly place: Place;
  readonly moving: boolean;
  readonly standby: boolean;
  /** True when this second counts towards moving hours (the clock runs unless in standby). */
  readonly clockRuns: boolean;
}

function samePlace(a: Place, b: Place): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'outside' || b.kind === 'outside') return true;
  return a.areaId === b.areaId && a.version === b.version;
}

function kmhBetween(a: TimedPoint, b: TimedPoint): number {
  return (distanceMeters(a, b) / Math.max(1, b.t - a.t)) * 3.6;
}

/** Decides what to do with this second's fix, and the run of jumps that follows from it. */
function judge(
  fix: GpsFix | undefined,
  t: number,
  s: TrackerState,
  rules: TrackerRules,
): { verdict: FixVerdict; jumps: readonly TimedPoint[] } {
  if (!fix) return { verdict: 'no-fix', jumps: s.jumps };
  if (fix.t !== t) throw new RangeError(`Fix time ${fix.t} is not this second ${t}`);
  if (!(fix.accuracyM <= rules.maxAccuracyM)) return { verdict: 'poor-accuracy', jumps: s.jumps };
  const p = { t, lat: fix.lat, lng: fix.lng };
  if (!s.lastGood || kmhBetween(s.lastGood, p) <= rules.maxSpeedKmh) {
    return { verdict: 'used', jumps: [] };
  }
  // A jump. Keep a run only while its fixes agree with each other; a scattered run starts again.
  const last = s.jumps.at(-1);
  const run = last && kmhBetween(last, p) <= rules.maxSpeedKmh ? [...s.jumps, p] : [p];
  return run.length >= rules.jumpResetAfter
    ? { verdict: 'reset', jumps: [] }
    : { verdict: 'jump', jumps: run };
}

/** Start-to-end speed over the last `windowSeconds`, or undefined without enough track. */
function windowKmh(
  track: readonly TimedPoint[],
  now: number,
  windowSeconds: number,
): number | undefined {
  const from = now - windowSeconds;
  const first = track.find((p) => p.t >= from);
  const last = track.at(-1);
  if (!first || !last || last.t - first.t < windowSeconds / 2) return undefined;
  return (distanceMeters(first, last) / (last.t - first.t)) * 3.6;
}

/** After a GPS gap longer than this (seconds), smoothing starts afresh (as minute distances do). */
export const FRESH_AFTER_GAP_SECONDS = 10;

/**
 * Advance one second. `t` must grow by whole seconds; a missing `fix` means no GPS this second.
 * `areas` are the areas that are on, in the versions in force now.
 */
export function step(
  s: TrackerState,
  t: number,
  fix: GpsFix | undefined,
  areas: readonly AreaVersion[],
  rules: TrackerRules = DEFAULT_TRACKER_RULES,
): { state: TrackerState; second: Second } {
  if (s.t !== undefined && t <= s.t) throw new RangeError(`Time went backwards: ${t} after ${s.t}`);
  const { verdict, jumps } = judge(fix, t, s, rules);

  let { lastGood, recent, track } = s;
  if ((verdict === 'used' || verdict === 'reset') && fix) {
    const p = { t, lat: fix.lat, lng: fix.lng };
    // After a reset the old positions were the bad ones; after a long gap they are stale (averaged
    // in, they would add a distance never ridden, review P2.8): start the average and track afresh.
    const reset =
      verdict === 'reset' ||
      (s.lastGood !== undefined && t - s.lastGood.t > FRESH_AFTER_GAP_SECONDS);
    lastGood = p;
    recent = reset ? [p] : [...recent, p].slice(-rules.smoothOver);
    const smooth = {
      t,
      lat: recent.reduce((sum, q) => sum + q.lat, 0) / recent.length,
      lng: recent.reduce((sum, q) => sum + q.lng, 0) / recent.length,
    };
    track = reset ? [smooth] : [...track, smooth];
  }
  const keepFrom = t - Math.max(rules.movingWindowSeconds, rules.wakeWindowSeconds);
  track = track.filter((p) => p.t >= keepFrom);
  const position = track.at(-1);
  const fresh = position !== undefined && position.t === t;

  // P1.2.2: the area, with a hold so a bike riding along a border does not flicker. The new area
  // must be seen on `areaHoldSeconds` seconds with GPS; seconds without GPS do not count.
  let { place, pending } = s;
  if (fresh) {
    const seen = locate(position, areas);
    if (samePlace(seen, place)) pending = undefined;
    else if (s.lastGood === undefined) place = seen;
    else if (pending && samePlace(pending.place, seen))
      pending = { place: seen, seen: pending.seen + 1 };
    else pending = { place: seen, seen: 1 };
    if (pending && pending.seen >= rules.areaHoldSeconds) {
      place = pending.place;
      pending = undefined;
    }
  }

  // P1.2.3: moving, and the 10-minute stop rule. The clock keeps running through short stops
  // (signals, pick-ups); after `standbyAfterSeconds` standing still the screen sleeps until the bike
  // moves again. A screen starts asleep.
  //  - Riding is confirmed by the full 30 s window; only that ends a stop.
  //  - The short 10 s window wakes the screen at once, but a push that is not confirmed does not
  //    restart the 10 minutes: the stop goes on from where it began.
  // Without GPS the bike cannot be shown to move, so a long signal loss also ends in standby.
  const confirmed = (windowKmh(track, t, rules.movingWindowSeconds) ?? 0) > rules.movingKmh;
  const waking = (windowKmh(track, t, rules.wakeWindowSeconds) ?? 0) > rules.movingKmh;
  const moving = confirmed || waking;
  const stillSince = confirmed ? undefined : (s.stillSince ?? t);
  const standby =
    moving || stillSince === undefined
      ? false
      : s.standby || t - stillSince + 1 > rules.standbyAfterSeconds;
  const state: TrackerState = {
    t,
    lastGood,
    jumps,
    recent,
    track,
    place,
    pending,
    moving,
    stillSince,
    standby,
  };
  return {
    state,
    second: {
      t,
      fix: verdict,
      position: fresh ? { lat: position.lat, lng: position.lng } : undefined,
      place,
      moving,
      standby,
      clockRuns: !standby,
    },
  };
}
