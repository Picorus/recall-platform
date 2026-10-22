import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  distanceMeters,
  distanceToBorderMeters,
  isSimpleRing,
  pointInRing,
  ringAreaSqm,
  ringsMeet,
  type Ring,
} from '../src/geo.js';

const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];

describe('distances', () => {
  it('one degree of latitude is about 111.2 km', () => {
    expect(distanceMeters({ lat: 17, lng: 78 }, { lat: 18, lng: 78 })).toBeCloseTo(111_195, -1);
  });

  it('flat distance to a border matches the great-circle distance within 0.1% across a city', () => {
    const square = box(17.4, 78.4, 17.41, 78.41);
    fc.assert(
      fc.property(fc.double({ min: 0.0005, max: 0.2, noNaN: true }), (d) => {
        const p = { lat: 17.405, lng: 78.41 + d };
        const exact = distanceMeters(p, { lat: 17.405, lng: 78.41 });
        expect(Math.abs(distanceToBorderMeters(p, square) - exact)).toBeLessThan(exact * 0.001);
      }),
    );
  });
});

describe('shapes', () => {
  it('a 1 km box has about 1 km²', () => {
    const km = 1000 / 111_195;
    const area = ringAreaSqm(
      box(17.4, 78.4, 17.4 + km, 78.4 + km / Math.cos((17.4 * Math.PI) / 180)),
    );
    expect(area).toBeGreaterThan(995_000);
    expect(area).toBeLessThan(1_005_000);
  });

  it('point in shape, also for a concave shape', () => {
    const l: Ring = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 2 },
      { lat: 1, lng: 2 },
      { lat: 1, lng: 1 },
      { lat: 2, lng: 1 },
      { lat: 2, lng: 0 },
    ];
    expect(pointInRing({ lat: 0.5, lng: 1.5 }, l)).toBe(true);
    expect(pointInRing({ lat: 1.5, lng: 0.5 }, l)).toBe(true);
    expect(pointInRing({ lat: 1.5, lng: 1.5 }, l)).toBe(false);
  });

  it('rejects crossed, folded, repeated-corner and too-small shapes', () => {
    expect(isSimpleRing(box(17.4, 78.4, 17.41, 78.41))).toBe(true);
    const bowtie: Ring = [
      { lat: 17.4, lng: 78.4 },
      { lat: 17.41, lng: 78.41 },
      { lat: 17.4, lng: 78.41 },
      { lat: 17.41, lng: 78.4 },
    ];
    expect(isSimpleRing(bowtie)).toBe(false);
    const folded: Ring = [
      { lat: 17.4, lng: 78.4 },
      { lat: 17.4, lng: 78.42 },
      { lat: 17.4, lng: 78.41 },
      { lat: 17.41, lng: 78.41 },
    ];
    expect(isSimpleRing(folded)).toBe(false);
    const repeated: Ring = [...box(17.4, 78.4, 17.41, 78.41), { lat: 17.41, lng: 78.4 }];
    expect(isSimpleRing(repeated)).toBe(false);
    expect(isSimpleRing(box(17.4, 78.4, 17.4, 78.41))).toBe(false);
    expect(isSimpleRing(box(17.4, 78.4, 17.41, 78.41).slice(0, 2))).toBe(false);
  });

  it('shapes meet when they cross, touch, or one holds the other; not when apart', () => {
    const a = box(17.4, 78.4, 17.41, 78.41);
    expect(ringsMeet(a, box(17.405, 78.405, 17.42, 78.42))).toBe(true);
    expect(ringsMeet(a, box(17.41, 78.4, 17.42, 78.41))).toBe(true);
    expect(ringsMeet(a, box(17.402, 78.402, 17.403, 78.403))).toBe(true);
    expect(ringsMeet(box(17.402, 78.402, 17.403, 78.403), a)).toBe(true);
    expect(ringsMeet(a, box(17.4101, 78.4, 17.42, 78.41))).toBe(false);
  });
});
