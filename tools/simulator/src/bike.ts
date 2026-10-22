// One fake delivery bike: rides between pick-ups and drops along the streets, waits at signals and
// shops, sometimes takes a long break, and its GPS is as messy as a real one (P1.10.1).
import type { GpsFix, LatLng } from '@recall/domain';
import { nearestNode, nodeToLatLng, route, type Node, type RoadGrid } from './roads.js';
import type { Rng } from './rng.js';

const M_PER_DEG_LAT = 111_195;

/** How the world behaves. Every number here is a guess to be tuned against real rides in the POC. */
export interface BikeHabits {
  /** Cruising speed range for a trip, km/h. */
  readonly speedKmh: readonly [number, number];
  /** Chance of waiting at a crossing (signal, traffic), and how long, seconds. */
  readonly signalChance: number;
  readonly signalSeconds: readonly [number, number];
  /** Stop at the end of a trip: short (pick-up/drop) or a long break. */
  readonly shortStopSeconds: readonly [number, number];
  readonly longBreakChance: number;
  readonly longBreakSeconds: readonly [number, number];
  /** Trip length in streets (each 250 m). */
  readonly tripStreets: readonly [number, number];
  /** Where trips go: anywhere, or with this chance to a hotspot (e.g. a cricket ground). */
  readonly hotspot?: { readonly at: LatLng; readonly chance: number };
  /** GPS: normal spread (m), chance of a poor fix, chance of a wild jump, chance a signal loss starts. */
  readonly gpsSpreadM: number;
  readonly poorFixChance: number;
  readonly jumpChance: number;
  readonly lossChance: number;
  readonly lossSeconds: readonly [number, number];
  /** Battery: drain a hour (percent) and the starting charge range. */
  readonly drainPerHour: number;
  readonly startCharge: readonly [number, number];
}

export const NORMAL_HABITS: BikeHabits = {
  speedKmh: [15, 35],
  signalChance: 0.12,
  signalSeconds: [20, 90],
  shortStopSeconds: [90, 420],
  longBreakChance: 0.08,
  longBreakSeconds: [900, 2700],
  tripStreets: [6, 24],
  gpsSpreadM: 4,
  poorFixChance: 0.02,
  jumpChance: 0.001,
  lossChance: 1 / 1800,
  lossSeconds: [20, 180],
  drainPerHour: 7,
  startCharge: [70, 100],
};

interface Riding {
  readonly kind: 'riding';
  readonly path: readonly Node[];
  readonly leg: number;
  readonly metres: number;
  readonly speed: number;
}

/** Standing still until `until`; then carry on with `resume`, or start a new trip. */
interface Waiting {
  readonly kind: 'waiting';
  readonly until: number;
  readonly since: number;
  readonly resume: Riding | undefined;
}

type Doing = Riding | Waiting | { readonly kind: 'dead' };

export interface Bike {
  readonly id: string;
  readonly at: Node;
  readonly doing: Doing;
  readonly charge: number;
  /** GPS lost until this second (exclusive), if lost. */
  readonly lostUntil: number;
}

/** What really happened this second, to check the screen logic against. */
export interface Truth {
  readonly position: LatLng;
  /** True while riding. */
  readonly riding: boolean;
  /** Seconds standing still so far (0 while riding). */
  readonly stillFor: number;
  /** False once the battery is flat: the screen is off. */
  readonly screenOn: boolean;
}

function lerp(a: LatLng, b: LatLng, f: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

function startTrip(grid: RoadGrid, from: Node, habits: BikeHabits, rng: Rng): Doing {
  let to: Node;
  if (habits.hotspot && rng.chance(habits.hotspot.chance)) {
    const h = nearestNode(grid, habits.hotspot.at);
    to = { col: h.col + rng.int(-2, 2), row: h.row + rng.int(-2, 2) };
  } else {
    const n = rng.int(habits.tripStreets[0], habits.tripStreets[1]);
    const east = rng.int(0, n);
    to = {
      col: from.col + (rng.chance(0.5) ? east : -east),
      row: from.row + (rng.chance(0.5) ? n - east : east - n),
    };
  }
  to = {
    col: Math.min(grid.columns - 1, Math.max(0, to.col)),
    row: Math.min(grid.rows - 1, Math.max(0, to.row)),
  };
  const path = route(from, to, rng.chance(0.5));
  const speed = rng.between(habits.speedKmh[0], habits.speedKmh[1]) / 3.6;
  return path.length < 2
    ? { kind: 'waiting', until: 0, since: 0, resume: undefined }
    : { kind: 'riding', path, leg: 0, metres: 0, speed };
}

export function newBike(id: string, grid: RoadGrid, habits: BikeHabits, rng: Rng, t: number): Bike {
  const at = { col: rng.int(0, grid.columns - 1), row: rng.int(0, grid.rows - 1) };
  // Some bikes start the hour parked (at a shop or home), the rest already riding.
  const doing: Doing = rng.chance(0.3)
    ? {
        kind: 'waiting',
        until: t + rng.int(60, 900),
        since: t - rng.int(0, 300),
        resume: undefined,
      }
    : startTrip(grid, at, habits, rng);
  return {
    id,
    at,
    doing,
    charge: rng.between(habits.startCharge[0], habits.startCharge[1]),
    lostUntil: 0,
  };
}

function positionOf(grid: RoadGrid, bike: Bike): LatLng {
  const d = bike.doing;
  if (d.kind !== 'riding') return nodeToLatLng(grid, bike.at);
  const a = d.path[d.leg] ?? bike.at;
  const b = d.path[d.leg + 1] ?? a;
  return lerp(nodeToLatLng(grid, a), nodeToLatLng(grid, b), d.metres / grid.spacingM);
}

/** Moves the bike one second forward. */
export function tick(grid: RoadGrid, bike: Bike, habits: BikeHabits, rng: Rng, t: number): Bike {
  const charge = Math.max(0, bike.charge - habits.drainPerHour / 3600);
  if (bike.doing.kind === 'dead' || charge === 0)
    return { ...bike, charge, doing: { kind: 'dead' } };
  let lostUntil = bike.lostUntil;
  if (t >= lostUntil && rng.chance(habits.lossChance)) {
    lostUntil = t + rng.int(habits.lossSeconds[0], habits.lossSeconds[1]);
  }
  const d = bike.doing;
  if (d.kind === 'waiting') {
    if (t < d.until) return { ...bike, charge, lostUntil };
    return { ...bike, charge, lostUntil, doing: d.resume ?? startTrip(grid, bike.at, habits, rng) };
  }
  let { leg, metres } = d;
  let at = bike.at;
  metres += d.speed * Math.exp(rng.normal(0.1));
  while (metres >= grid.spacingM && leg < d.path.length - 1) {
    metres -= grid.spacingM;
    leg += 1;
    at = d.path[leg] ?? at;
    if (leg === d.path.length - 1) {
      const long = rng.chance(habits.longBreakChance);
      const [lo, hi] = long ? habits.longBreakSeconds : habits.shortStopSeconds;
      const until = t + rng.int(lo, hi);
      return {
        ...bike,
        at,
        charge,
        lostUntil,
        doing: { kind: 'waiting', until, since: t, resume: undefined },
      };
    }
    if (rng.chance(habits.signalChance)) {
      // Wait at the crossing, then carry on the same way.
      const until = t + rng.int(habits.signalSeconds[0], habits.signalSeconds[1]);
      const resume: Riding = {
        kind: 'riding',
        path: d.path.slice(leg),
        leg: 0,
        metres: 0,
        speed: d.speed,
      };
      return {
        ...bike,
        at,
        charge,
        lostUntil,
        doing: { kind: 'waiting', until, since: t, resume },
      };
    }
  }
  return { ...bike, at, charge, lostUntil, doing: { ...d, leg, metres } };
}

/** What the bike really did this second. */
export function truthOf(grid: RoadGrid, bike: Bike, t: number): Truth {
  const d = bike.doing;
  return {
    position: positionOf(grid, bike),
    riding: d.kind === 'riding',
    stillFor: d.kind === 'waiting' ? t - d.since : 0,
    screenOn: d.kind !== 'dead',
  };
}

/** What the screen's GPS chip reports this second (or nothing). */
export function gpsOf(
  grid: RoadGrid,
  bike: Bike,
  habits: BikeHabits,
  rng: Rng,
  t: number,
): GpsFix | undefined {
  if (bike.doing.kind === 'dead' || t < bike.lostUntil) return undefined;
  const p = positionOf(grid, bike);
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180);
  if (rng.chance(habits.jumpChance)) {
    return {
      t,
      lat: p.lat + rng.between(-0.04, 0.04),
      lng: p.lng + rng.between(-0.04, 0.04),
      accuracyM: 8,
    };
  }
  const poor = rng.chance(habits.poorFixChance);
  const spread = poor ? habits.gpsSpreadM * 15 : habits.gpsSpreadM;
  return {
    t,
    lat: p.lat + rng.normal(spread) / M_PER_DEG_LAT,
    lng: p.lng + rng.normal(spread) / mPerDegLng,
    accuracyM: poor ? rng.between(60, 150) : rng.between(3, 12),
  };
}
