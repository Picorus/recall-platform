// The demo's maps stand-in (P4.4): real west Hyderabad roads for the rider's map, joined into
// strokes (a long straight run is a main road), and only the roads near the point asked about.
import { describe, expect, it } from 'vitest';
import type { RoadData } from '@recall/simulator';
import { demoMaps, strokesOf } from '../../src/road-map.js';

/** A 3 km road east–west with points every 100 m, and a 300 m side street north from its middle. */
const data: RoadData = (() => {
  const points: number[] = [];
  const pieces: number[] = [];
  for (let i = 0; i <= 30; i++) points.push(1_744_000, 7_837_000 + i * 94);
  for (let i = 0; i < 30; i++) pieces.push(i, i + 1);
  for (let j = 1; j <= 3; j++) points.push(1_744_000 + j * 90, 7_837_000 + 15 * 94);
  pieces.push(15, 31, 31, 32, 32, 33);
  return {
    source: 'test',
    licence: 'test',
    fetchedAt: '2026-10-28T00:00:00Z',
    box: { south: 17.4, west: 78.3, north: 17.5, east: 78.4 },
    points,
    pieces,
  };
})();

describe("the demo's road map (P4.4)", () => {
  it('a long straight road is one main stroke; a short side street is not main', () => {
    const strokes = strokesOf(data);
    expect(strokes).toHaveLength(2);
    const main = strokes.find((s) => s.main);
    const side = strokes.find((s) => !s.main);
    // Straight: simplified to its two ends.
    expect(main?.points).toEqual([
      [17.44, 78.37],
      [17.44, 78.3982],
    ]);
    expect(side?.points.at(-1)).toEqual([17.4427, 78.3841]);
  });

  it('the real roads near Hitech City, and nothing near a point far outside the map', async () => {
    const maps = demoMaps();
    const near = (await maps.roadsNear?.(17.4474, 78.3762, 900)) ?? [];
    expect(near.length).toBeGreaterThan(30);
    expect(near.some((r) => r.main)).toBe(true);
    for (const r of near) {
      // Each kept piece reaches into the square (one point beyond its edge allowed).
      expect(
        r.points.some(
          ([la, ln]) => Math.abs(la - 17.4474) < 0.01 && Math.abs(ln - 78.3762) < 0.011,
        ),
      ).toBe(true);
    }
    expect((await maps.roadsNear?.(18.5, 79.5, 900)) ?? []).toEqual([]);
    expect(await maps.streetAt(17.448, 78.3915)).toBe('Madhapur Main Road');
    expect(maps.credit).toBe('© OpenStreetMap contributors');
  });
});
