// The demo's maps stand-in (P4.4): the rider app's "where am I" map draws the real streets of west
// Hyderabad, from the simulator's OpenStreetMap road file (tools/simulator/data, © OpenStreetMap
// contributors, ODbL), so the demo looks like the real thing with no maps account. Street names
// still come from the plain fake (the road file has no names). Laptop and demo only: the real
// provider comes with the maps account (P6).
//
// The road file has points and the pieces between them, but no road kinds. Roads are joined into
// "strokes": at each crossing a road carries on along its straightest continuation, and a stroke
// that runs on for 2 km or more is drawn as a main road (long straight runs are the big roads).
import { fakeMaps, type MapsAdapter, type RoadLine } from '@recall/adapters';
import { segmentHitsBox } from '@recall/domain';
import { OSM_ROADS_FILE, type RoadData } from '@recall/simulator';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const M_PER_DEG = 111_195;
/** A stroke this long or longer is a main road. */
const MAIN_M = 2_000;
/** Two pieces at a crossing continue each other when they bend less than this (degrees). */
const STRAIGHT_DEG = 40;
/** Points closer than this to the line are dropped (metres): the phone needs no more. */
const SIMPLIFY_M = 3;
/** Look-up squares for "roads near", in degrees (about 550 m). */
const CELL = 0.005;

interface Stroke {
  readonly main: boolean;
  readonly points: readonly (readonly [number, number])[];
}

/** Douglas–Peucker on a polyline in local metres. */
function simplify(
  pts: readonly (readonly [number, number])[],
  tolM: number,
): (readonly [number, number])[] {
  if (pts.length <= 2) return [...pts];
  const lat0 = pts[0]?.[0] ?? 0;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map(([la, ln]) => [ln * kx, la * M_PER_DEG] as const);
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    const [ax, ay] = xy[a] as readonly [number, number];
    const [bx, by] = xy[b] as readonly [number, number];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i] as readonly [number, number];
      const d = Math.abs(dy * (px - ax) - dx * (py - ay)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolM && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

/** Joins the road pieces into strokes (see the top of this file). */
export function strokesOf(data: RoadData): Stroke[] {
  const n = data.points.length / 2;
  const lat = (i: number) => (data.points[2 * i] ?? 0) / 1e5;
  const lng = (i: number) => (data.points[2 * i + 1] ?? 0) / 1e5;
  // Each piece once.
  const seen = new Set<number>();
  const ea: number[] = [];
  const eb: number[] = [];
  for (let k = 0; k + 1 < data.pieces.length; k += 2) {
    const a = data.pieces[k] ?? 0;
    const b = data.pieces[k + 1] ?? 0;
    if (a === b) continue;
    const key = Math.min(a, b) * n + Math.max(a, b);
    if (seen.has(key)) continue;
    seen.add(key);
    ea.push(a);
    eb.push(b);
  }
  const edges = ea.length;
  const at: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges; e++) {
    at[ea[e] ?? 0]?.push(e);
    at[eb[e] ?? 0]?.push(e);
  }
  const other = (e: number, v: number) => ((ea[e] ?? 0) === v ? (eb[e] ?? 0) : (ea[e] ?? 0));
  const bearing = (v: number, w: number) => {
    const kx = Math.cos((lat(v) * Math.PI) / 180);
    return Math.atan2(lat(w) - lat(v), (lng(w) - lng(v)) * kx);
  };
  // At each point, the straightest pairs of pieces continue each other.
  const cont = new Map<number, number>(); // key: e * n + v  →  the piece it continues into at v
  for (let v = 0; v < n; v++) {
    const es = at[v] ?? [];
    if (es.length < 2) continue;
    const dirs = es.map((e) => bearing(v, other(e, v)));
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        let d = Math.abs((dirs[i] ?? 0) - (dirs[j] ?? 0));
        if (d > Math.PI) d = 2 * Math.PI - d;
        const bend = ((Math.PI - d) * 180) / Math.PI;
        if (bend <= STRAIGHT_DEG || es.length === 2) pairs.push([bend, i, j]);
      }
    pairs.sort((x, y) => x[0] - y[0]);
    const used = new Set<number>();
    for (const [, i, j] of pairs) {
      if (used.has(i) || used.has(j)) continue;
      used.add(i);
      used.add(j);
      const ei = es[i] ?? 0;
      const ej = es[j] ?? 0;
      cont.set(ei * n + v, ej);
      cont.set(ej * n + v, ei);
    }
  }
  const done = new Uint8Array(edges);
  const strokes: Stroke[] = [];
  for (let e0 = 0; e0 < edges; e0++) {
    if (done[e0]) continue;
    done[e0] = 1;
    // Walk forwards from eb, then backwards from ea.
    const walk = (start: number): number[] => {
      const out: number[] = [];
      let e = e0;
      let v = start;
      for (;;) {
        const next = cont.get(e * n + v);
        if (next === undefined || done[next]) break;
        done[next] = 1;
        v = other(next, v);
        out.push(v);
        e = next;
      }
      return out;
    };
    const a = ea[e0] ?? 0;
    const b = eb[e0] ?? 0;
    const fwd = walk(b);
    const back = walk(a);
    const ids = [...back.reverse(), a, b, ...fwd];
    const pts = ids.map((i) => [lat(i), lng(i)] as const);
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1] as readonly [number, number];
      const q = pts[i] as readonly [number, number];
      len += Math.hypot(
        (q[0] - p[0]) * M_PER_DEG,
        (q[1] - p[1]) * M_PER_DEG * Math.cos((p[0] * Math.PI) / 180),
      );
    }
    strokes.push({ main: len >= MAIN_M, points: simplify(pts, SIMPLIFY_M) });
  }
  return strokes;
}

/** Maps for the demo: real west Hyderabad roads around a point; the fake's street names. */
export function demoMaps(file: string = OSM_ROADS_FILE): MapsAdapter {
  const names = fakeMaps();
  if (!existsSync(file)) return names;
  const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RoadData;
  const strokes = strokesOf(data);
  // Which strokes pass through each look-up square.
  const cells = new Map<string, number[]>();
  strokes.forEach((s, id) => {
    const mine = new Set<string>();
    for (const [la, ln] of s.points) mine.add(`${Math.floor(la / CELL)}:${Math.floor(ln / CELL)}`);
    // Long pieces skip squares: also mark the squares between their ends.
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i - 1] as readonly [number, number];
      const q = s.points[i] as readonly [number, number];
      const steps = Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) / CELL);
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        mine.add(
          `${Math.floor((p[0] + (q[0] - p[0]) * f) / CELL)}:${Math.floor((p[1] + (q[1] - p[1]) * f) / CELL)}`,
        );
      }
    }
    for (const c of mine) {
      const list = cells.get(c);
      if (list) list.push(id);
      else cells.set(c, [id]);
    }
  });
  return {
    credit: '© OpenStreetMap contributors',
    streetAt: (lat, lng) => names.streetAt(lat, lng),
    roadsNear(lat, lng, metres) {
      const r = Math.max(0, Math.min(metres, 3_000));
      const dLat = r / M_PER_DEG;
      const dLng = r / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
      const ids = new Set<number>();
      for (let y = Math.floor((lat - dLat) / CELL); y <= Math.floor((lat + dLat) / CELL); y++)
        for (let x = Math.floor((lng - dLng) / CELL); x <= Math.floor((lng + dLng) / CELL); x++)
          for (const id of cells.get(`${y}:${x}`) ?? []) ids.add(id);
      // Only the part of each road that reaches into the square (with a margin).
      const out: RoadLine[] = [];
      const [s0, w0, n0, e0] = [
        lat - dLat * 1.2,
        lng - dLng * 1.2,
        lat + dLat * 1.2,
        lng + dLng * 1.2,
      ];
      for (const id of ids) {
        const s = strokes[id];
        if (!s) continue;
        let run: (readonly [number, number])[] = [];
        for (let i = 1; i < s.points.length; i++) {
          const p = s.points[i - 1] as readonly [number, number];
          const q = s.points[i] as readonly [number, number];
          if (segmentHitsBox(p[1], p[0], q[1], q[0], w0, s0, e0, n0)) {
            if (run.length === 0) run.push(p);
            run.push(q);
          } else if (run.length > 0) {
            out.push({ main: s.main, points: run });
            run = [];
          }
        }
        if (run.length >= 2) out.push({ main: s.main, points: run });
      }
      return Promise.resolve(out);
    },
  };
}
