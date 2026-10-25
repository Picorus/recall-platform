// P1.10.1 version 2: the real OpenStreetMap roads of west Hyderabad as a road map. Bikes take the
// shortest way by road (A* search), stop at signals only where roads meet, and start and end trips
// at real road points.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { LatLng } from '@recall/domain';
import type { RoadData } from './osm.js';
import { gridMap, metresBetween, type RoadMap } from './roads.js';
import type { Rng } from './rng.js';

/** Where the downloaded road map lives (see data/README.md). */
export const OSM_ROADS_FILE = join(import.meta.dirname, '../data/west-hyderabad-roads.json.gz');

const M_PER_DEG_LAT = 111_195;
/** Size of the look-up squares for "nearest point", in degrees (about 220 m). */
const CELL = 0.002;

/** A small binary heap of (key, value), smallest key first. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    const k = this.keys;
    const v = this.values;
    let i = k.length;
    k.push(key);
    v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((k[p] ?? 0) <= key) break;
      k[i] = k[p] ?? 0;
      v[i] = v[p] ?? 0;
      i = p;
    }
    k[i] = key;
    v[i] = value;
  }
  pop(): number {
    const k = this.keys;
    const v = this.values;
    const top = v[0] ?? -1;
    const lastK = k.pop() ?? 0;
    const lastV = v.pop() ?? 0;
    if (k.length === 0) return top;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= k.length) break;
      const r = l + 1;
      const c = r < k.length && (k[r] ?? 0) < (k[l] ?? 0) ? r : l;
      if ((k[c] ?? 0) >= lastK) break;
      k[i] = k[c] ?? 0;
      v[i] = v[c] ?? 0;
      i = c;
    }
    k[i] = lastK;
    v[i] = lastV;
    return top;
  }
}

/** Builds a road map from road data (points and road pieces). */
export function graphMap(data: RoadData, name = 'osm'): RoadMap {
  const n = data.points.length / 2;
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lat[i] = (data.points[2 * i] ?? 0) / 1e5;
    lng[i] = (data.points[2 * i + 1] ?? 0) / 1e5;
  }
  const pos = (i: number): LatLng => ({ lat: lat[i] ?? 0, lng: lng[i] ?? 0 });
  // Neighbours in compressed rows: start[i] … start[i + 1] in `to` and `len`.
  const degree = new Int32Array(n);
  for (let k = 0; k < data.pieces.length; k += 2) {
    degree[data.pieces[k] ?? 0] = (degree[data.pieces[k] ?? 0] ?? 0) + 1;
    degree[data.pieces[k + 1] ?? 0] = (degree[data.pieces[k + 1] ?? 0] ?? 0) + 1;
  }
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = (start[i] ?? 0) + (degree[i] ?? 0);
  const fill = start.slice(0, n);
  const to = new Int32Array(data.pieces.length);
  const len = new Float64Array(data.pieces.length);
  for (let k = 0; k < data.pieces.length; k += 2) {
    const a = data.pieces[k] ?? 0;
    const b = data.pieces[k + 1] ?? 0;
    const d = metresBetween(pos(a), pos(b));
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const at = fill[x] ?? 0;
      to[at] = y;
      len[at] = d;
      fill[x] = at + 1;
    }
  }
  // Look-up squares for "nearest point".
  const cells = new Map<string, number[]>();
  const cellOf = (la: number, ln: number) => `${Math.floor(la / CELL)}|${Math.floor(ln / CELL)}`;
  for (let i = 0; i < n; i++) {
    const key = cellOf(lat[i] ?? 0, lng[i] ?? 0);
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }
  const nearest = (p: LatLng): number => {
    const cy = Math.floor(p.lat / CELL);
    const cx = Math.floor(p.lng / CELL);
    let best = 0;
    let bestD = Infinity;
    for (let ring = 0; ring < 200; ring++) {
      for (let dy = -ring; dy <= ring; dy++)
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const i of cells.get(`${cy + dy}|${cx + dx}`) ?? []) {
            const d = metresBetween(p, pos(i));
            if (d < bestD) [best, bestD] = [i, d];
          }
        }
      // Anything in the next ring is at least `ring` squares away.
      if (bestD < ring * CELL * M_PER_DEG_LAT * 0.9) break;
    }
    return best;
  };
  const offset = (p: LatLng, metres: number, rng: Rng): LatLng => {
    const angle = rng.between(0, 2 * Math.PI);
    return {
      lat: p.lat + (Math.sin(angle) * metres) / M_PER_DEG_LAT,
      lng: p.lng + (Math.cos(angle) * metres) / (M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180)),
    };
  };
  // A* search, reusing its arrays between searches.
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const touched: number[] = [];
  const route = (a: number, b: number): number[] => {
    for (const i of touched) {
      g[i] = Infinity;
      prev[i] = -1;
      done[i] = 0;
    }
    touched.length = 0;
    const target = pos(b);
    const heap = new Heap();
    g[a] = 0;
    touched.push(a);
    heap.push(metresBetween(pos(a), target), a);
    while (heap.size > 0) {
      const x = heap.pop();
      if (x === b) break;
      if (done[x]) continue;
      done[x] = 1;
      for (let k = start[x] ?? 0; k < (start[x + 1] ?? 0); k++) {
        const y = to[k] ?? 0;
        const cost = (g[x] ?? 0) + (len[k] ?? 0);
        if (cost < (g[y] ?? Infinity)) {
          if (g[y] === Infinity) touched.push(y);
          g[y] = cost;
          prev[y] = x;
          heap.push(cost + metresBetween(pos(y), target), y);
        }
      }
    }
    if (a !== b && prev[b] === -1) return [a];
    const path = [b];
    for (let x = b; x !== a;) {
      x = prev[x] ?? a;
      path.push(x);
    }
    return path.reverse();
  };
  return {
    name,
    size: n,
    position: pos,
    nearest,
    anyPoint: (rng) => rng.int(0, n - 1),
    tripEnd: (from, metres, rng) => nearest(offset(pos(from), metres, rng)),
    near: (p, rng) => nearest(offset(p, rng.between(0, 500), rng)),
    route: (a, b) => route(a, b),
    isCrossing: (i) => (degree[i] ?? 0) >= 3,
  };
}

let cached: RoadMap | undefined;

/** The real roads, if the road map has been downloaded (data/README.md); else undefined. */
export function osmRoads(file = OSM_ROADS_FILE): RoadMap | undefined {
  if (file === OSM_ROADS_FILE && cached) return cached;
  if (!existsSync(file)) return undefined;
  const data = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as RoadData;
  const map = graphMap(data);
  if (file === OSM_ROADS_FILE) cached = map;
  return map;
}

/** The real roads when downloaded, else the street grid (version 1). */
export const defaultRoads = (): RoadMap => osmRoads() ?? gridMap();
