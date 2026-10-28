// P4.4: "where am I" in the rider app, a map kept just in case (like other riding apps). The screen
// on his bike is the only source of where he is (hard rule 1): his last position, his route today
// from the positions it sent, and the roads around him for a base map. Everything sent to the phone
// is small and bounded: a thinned route, the roads within a short distance, never anyone else.
import { distanceMeters, type LatLng } from './geo.js';

export interface WhereRules {
  /** Roads are drawn this far around him (metres). */
  readonly roadsRadiusM: number;
  /** At most this many road lines… */
  readonly maxRoadLines: number;
  /** …holding at most this many points in all. */
  readonly maxRoadPoints: number;
  /** His route today is thinned to at most this many points. */
  readonly maxRoutePoints: number;
  /** A position this recent is "now"; older ones show their time. */
  readonly liveSeconds: number;
  /** Older than this a position is "old" (say so plainly; it may be wrong). */
  readonly oldSeconds: number;
  /** Roads are sent again only once he has moved this far from where they were last sent. */
  readonly roadsAgainM: number;
}

export const DEFAULT_WHERE_RULES: WhereRules = {
  roadsRadiusM: 1_000,
  maxRoadLines: 800,
  maxRoadPoints: 5_000,
  maxRoutePoints: 400,
  liveSeconds: 120,
  oldSeconds: 30 * 60,
  roadsAgainM: 300,
};

/** A road for the base map: its points as [lat, lng]; `main` for the bigger roads. */
export interface MapRoad {
  readonly main: boolean;
  readonly points: readonly (readonly [lat: number, lng: number])[];
}

/** How fresh a position is: "live" (just now), "recent" (show its time) or "old" (may be wrong). */
export function positionAge(
  now: number,
  t: number,
  rules: WhereRules = DEFAULT_WHERE_RULES,
): 'live' | 'recent' | 'old' {
  const age = now - t;
  if (age <= rules.liveSeconds) return 'live';
  if (age <= rules.oldSeconds) return 'recent';
  return 'old';
}

/**
 * At most `max` points of a route, oldest first, evenly spread over it: the first and the last
 * always kept (the last is where he is).
 */
export function thinRoute<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  if (max <= 0) return [];
  if (max === 1) return [points[points.length - 1] as T];
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)] as T);
  return out;
}

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * Whether the straight piece from (x1, y1) to (x2, y2) touches the box [minX, maxX] × [minY, maxY]
 * (an end inside it, or the piece crossing it): Liang–Barsky clipping.
 */
export function segmentHitsBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [
    [-dx, x1 - minX],
    [dx, maxX - x1],
    [-dy, y1 - minY],
    [dy, maxY - y1],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/**
 * The roads to send for a base map around `centre`: only the pieces that reach into a square
 * `radiusM` from it (a road leaving the square is cut after its first point beyond the edge, so it
 * still reaches the edge; a long straight piece crossing the square is kept whole), nearest roads
 * first, main roads before small ones at the same distance, cut at `maxRoadLines` lines and
 * `maxRoadPoints` points, coordinates rounded to about a metre. Whatever a maps provider answers,
 * the phone never gets more than this.
 */
export function boundRoads(
  roads: readonly MapRoad[],
  centre: LatLng,
  radiusM: number,
  rules: Pick<WhereRules, 'maxRoadLines' | 'maxRoadPoints'> = DEFAULT_WHERE_RULES,
): MapRoad[] {
  // Local metres around the centre (x east, y north): exact enough for a few kilometres.
  const kx = 111_195 * Math.cos((centre.lat * Math.PI) / 180);
  const xy = (p: readonly [number, number]) =>
    [(p[1] - centre.lng) * kx, (p[0] - centre.lat) * 111_195] as const;
  const r = radiusM;
  const pieces: { road: MapRoad; d: number }[] = [];
  for (const road of roads) {
    const pts = (Array.isArray(road.points) ? road.points : []).filter(
      (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    );
    const m = pts.map(xy);
    let run: number[] = [];
    const close = () => {
      if (run.length >= 2) {
        // How near the road comes to him: the nearest point of its pieces.
        let d = Number.POSITIVE_INFINITY;
        for (let k = 1; k < run.length; k++) {
          const [ax, ay] = m[run[k - 1] ?? 0] as readonly [number, number];
          const [bx, by] = m[run[k] ?? 0] as readonly [number, number];
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t =
            len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / len2));
          d = Math.min(d, Math.hypot(ax + t * (bx - ax), ay + t * (by - ay)));
        }
        pieces.push({
          road: {
            main: road.main === true,
            points: run.map((i) => {
              const p = pts[i] as readonly [number, number];
              return [round5(p[0]), round5(p[1])] as const;
            }),
          },
          d,
        });
      }
      run = [];
    };
    for (let i = 1; i < m.length; i++) {
      const [ax, ay] = m[i - 1] as readonly [number, number];
      const [bx, by] = m[i] as readonly [number, number];
      if (segmentHitsBox(ax, ay, bx, by, -r, -r, r, r)) {
        if (run.length === 0) run.push(i - 1);
        run.push(i);
      } else close();
    }
    close();
  }
  pieces.sort((a, b) => a.d - b.d || Number(b.road.main) - Number(a.road.main));
  const out: MapRoad[] = [];
  let points = 0;
  for (const p of pieces) {
    if (out.length >= rules.maxRoadLines) break;
    if (points + p.road.points.length > rules.maxRoadPoints) continue;
    out.push(p.road);
    points += p.road.points.length;
  }
  return out;
}

/** True when roads sent for a map around `was` still do for one around `now` (moved < 300 m). */
export function roadsStillCover(
  was: LatLng,
  now: LatLng,
  rules: Pick<WhereRules, 'roadsAgainM'> = DEFAULT_WHERE_RULES,
): boolean {
  return distanceMeters(was, now) < rules.roadsAgainM;
}
