import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  closedLine,
  DRAW,
  drawingEnds,
  drawOrder,
  drawnAt,
  outlineUpTo,
  sizeText,
  svgPaths,
  type MapArea,
} from '../../lib/area-shapes';

const box = (s: number, w: number, n: number, e: number) => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
const area = (areaId: string, ring: ReturnType<typeof box>, sqKm = 2.4): MapArea => ({
  areaId,
  name: areaId,
  version: 1,
  ring,
  edgeMeters: 300,
  sqKm,
});

describe('our areas map: drawing the outlines in (P5.4.1)', () => {
  const ring = box(17.4, 78.4, 17.41, 78.41);

  it('the closed outline goes back to the first corner, as [lng, lat]', () => {
    expect(closedLine(ring)).toEqual([
      [78.4, 17.4],
      [78.41, 17.4],
      [78.41, 17.41],
      [78.4, 17.41],
      [78.4, 17.4],
    ]);
  });

  it('nothing, part of it, then exactly the whole outline', () => {
    expect(outlineUpTo(ring, 0)).toEqual([
      [78.4, 17.4],
      [78.4, 17.4],
    ]);
    expect(outlineUpTo(ring, 1)).toEqual(closedLine(ring));
    expect(outlineUpTo(ring, 2)).toEqual(closedLine(ring));
    // A quarter of a square's border, measured along it: about its first side.
    const q = outlineUpTo(ring, 0.25);
    expect(q[q.length - 1]?.[0]).toBeCloseTo(78.41, 3);
    // Half way along the first side.
    const h = outlineUpTo(ring, 0.12);
    expect(h).toHaveLength(2);
    expect(h[1]?.[1]).toBe(17.4);
  });

  it('never goes backwards: more time, more outline', () => {
    let last = 0;
    for (let f = 0; f <= 1; f += 0.01) {
      const n = outlineUpTo(ring, f).length;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('one area after another; outline first, then the fill; all done at the end', () => {
    expect(drawnAt(0, 0, false)).toEqual({ line: 0, fill: 0 });
    expect(drawnAt(1, DRAW.stagger - 1, false).line).toBe(0);
    expect(drawnAt(0, DRAW.outline / 2, false).line).toBeGreaterThan(0.5);
    expect(drawnAt(0, DRAW.outline, false)).toEqual({ line: 1, fill: 0 });
    const end = drawingEnds(6);
    for (let i = 0; i < 6; i++) expect(drawnAt(i, end, false)).toEqual({ line: 1, fill: 1 });
    expect(drawnAt(5, end - 1, false).fill).toBeLessThan(1);
  });

  it('the drawing sweeps west to east', () => {
    const order = drawOrder([
      area('east', box(17.4, 78.45, 17.41, 78.46)),
      area('west', box(17.4, 78.3, 17.41, 78.31)),
      area('middle', box(17.4, 78.4, 17.41, 78.41)),
    ]);
    expect([...order.entries()]).toEqual([
      ['west', 0],
      ['middle', 1],
      ['east', 2],
    ]);
  });

  it('with reduced motion, everything is there at once', () => {
    for (const i of [0, 3, 9]) expect(drawnAt(i, 0, true)).toEqual({ line: 1, fill: 1 });
  });
});

describe('our areas map: words, bounds and the plain drawing', () => {
  it('sizes in km², two decimals under one', () => {
    expect(sizeText(2.43)).toBe('2.4 km²');
    expect(sizeText(0.62)).toBe('0.62 km²');
  });

  it('the box round every area', () => {
    const areas = [
      area('a', box(17.4, 78.4, 17.41, 78.41)),
      area('b', box(17.42, 78.38, 17.43, 78.39)),
    ];
    expect(boundsOf(areas)).toEqual([
      [78.38, 17.4],
      [78.41, 17.43],
    ]);
    expect(boundsOf([])).toBeUndefined();
  });

  it('without WebGL the same shapes are drawn inside the box, north up', () => {
    const paths = svgPaths(
      [area('a', box(17.4, 78.4, 17.41, 78.41)), area('b', box(17.42, 78.4, 17.43, 78.41))],
      600,
      420,
    );
    expect(paths.map((p) => p.areaId)).toEqual(['a', 'b']);
    for (const p of paths) {
      const nums = [...p.d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
      for (let i = 0; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(0);
        expect(nums[i]).toBeLessThanOrEqual(600);
        expect(nums[i + 1]).toBeGreaterThanOrEqual(0);
        expect(nums[i + 1]).toBeLessThanOrEqual(420);
      }
    }
    // b is north of a: higher up (smaller y).
    const y = (d: string) => Number(/,(-?\d+(\.\d+)?)/.exec(d)?.[1]);
    expect(y(paths[1]?.d ?? '')).toBeLessThan(y(paths[0]?.d ?? ''));
  });
});
