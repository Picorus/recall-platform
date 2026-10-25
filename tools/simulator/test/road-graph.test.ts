import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { RoadData } from '../src/osm.js';
import { graphMap, OSM_ROADS_FILE, osmRoads } from '../src/road-graph.js';
import { gridMap, metresBetween } from '../src/roads.js';
import { seeded } from '../src/rng.js';

/** A small ladder of roads: two parallel streets joined every 100 m, one long detour. */
function ladder(): RoadData {
  const points: number[] = [];
  const pieces: number[] = [];
  for (let i = 0; i < 10; i++) points.push(1_744_000, 7_838_000 + i * 100); // south street
  for (let i = 0; i < 10; i++) points.push(1_744_100, 7_838_000 + i * 100); // north street
  for (let i = 0; i < 9; i++) pieces.push(i, i + 1, 10 + i, 11 + i);
  for (const i of [0, 4, 9]) pieces.push(i, 10 + i); // three rungs
  const box = { south: 17.4, west: 78.3, north: 17.5, east: 78.5 };
  return { source: 'test', licence: 'test', fetchedAt: '', box, points, pieces };
}

const pathMetres = (m: ReturnType<typeof graphMap>, path: number[]) =>
  path.slice(1).reduce((t, p, i) => t + metresBetween(m.position(path[i] ?? 0), m.position(p)), 0);

describe('real roads as a road map (P1.10.1 version 2)', () => {
  const m = graphMap(ladder(), 'ladder');

  it('a route follows the roads, the shortest way, from start to end', () => {
    const path = m.route(2, 16, seeded(1));
    expect(path[0]).toBe(2);
    expect(path.at(-1)).toBe(16);
    // 2 → 4 along the south street, up the rung at 4, then along the north street to 16.
    expect(path).toEqual([2, 3, 4, 14, 15, 16]);
    expect(m.route(5, 5, seeded(1))).toEqual([5]);
  });

  it('bikes stop at signals only where roads meet', () => {
    expect([0, 1, 4, 14].map((i) => m.isCrossing(i))).toEqual([false, false, true, true]);
  });

  it('property: "nearest point" is truly the nearest', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 17.43, max: 17.45, noNaN: true }),
        fc.double({ min: 78.37, max: 78.4, noNaN: true }),
        (lat, lng) => {
          const p = { lat, lng };
          const best = Math.min(
            ...Array.from({ length: m.size }, (_, i) => metresBetween(p, m.position(i))),
          );
          expect(metresBetween(p, m.position(m.nearest(p)))).toBeCloseTo(best, 6);
        },
      ),
    );
  });

  const real = osmRoads();
  it.runIf(real !== undefined)(
    'the downloaded map: routes follow the roads and are the shortest (checked against a plain search)',
    () => {
      if (!real) return;
      expect(real.size).toBeGreaterThan(50_000);
      const data = JSON.parse(
        gunzipSync(readFileSync(OSM_ROADS_FILE)).toString('utf8'),
      ) as RoadData;
      // Neighbours, for the plain search and to check each step is a real road piece.
      const next = new Map<number, number[]>();
      for (let k = 0; k < data.pieces.length; k += 2) {
        const a = data.pieces[k] ?? 0;
        const b = data.pieces[k + 1] ?? 0;
        next.set(a, [...(next.get(a) ?? []), b]);
        next.set(b, [...(next.get(b) ?? []), a]);
      }
      const plain = (a: number, b: number) => {
        const dist = new Map([[a, 0]]);
        const open = new Set([a]);
        while (open.size > 0) {
          let x = -1;
          for (const o of open) if (x < 0 || (dist.get(o) ?? 0) < (dist.get(x) ?? 0)) x = o;
          open.delete(x);
          if (x === b) return dist.get(b) ?? Infinity;
          for (const y of next.get(x) ?? []) {
            const d = (dist.get(x) ?? 0) + metresBetween(real.position(x), real.position(y));
            if (d < (dist.get(y) ?? Infinity)) {
              dist.set(y, d);
              open.add(y);
            }
          }
        }
        return Infinity;
      };
      const rng = seeded(5);
      for (let k = 0; k < 4; k++) {
        const a = real.anyPoint(rng);
        const b = real.tripEnd(a, 1_000, rng);
        const path = real.route(a, b, rng);
        expect(path[0]).toBe(a);
        expect(path.at(-1)).toBe(b);
        for (let i = 1; i < path.length; i++)
          expect(next.get(path[i - 1] ?? -1)).toContain(path[i]);
        expect(pathMetres(real as ReturnType<typeof graphMap>, path)).toBeCloseTo(plain(a, b), 3);
      }
    },
    60_000,
  );

  it('the grid is a road map too', () => {
    const g = gridMap();
    const path = g.route(0, g.size - 1, seeded(1));
    expect(path[0]).toBe(0);
    expect(path.at(-1)).toBe(g.size - 1);
  });
});
