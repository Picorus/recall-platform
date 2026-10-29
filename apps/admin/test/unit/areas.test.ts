import {
  checkArea,
  launchAreas,
  overlapSqm,
  ringGap,
  sharedBorderMeters,
  type AreaVersion,
} from '@recall/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addCorner,
  closeGap,
  cornersText,
  metresPerPixel,
  parseCorners,
  round6,
  snapCorner,
  snapMetres,
  traceBetween,
  type Corner,
  type Neighbour,
  type Snap,
} from '../../lib/areas';

describe('Areas page helpers', () => {
  it('corners read back from their text', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lat: fc.integer({ min: -90_000_000, max: 90_000_000 }),
            lng: fc.integer({ min: -180_000_000, max: 180_000_000 }),
          }),
          { minLength: 3, maxLength: 30 },
        ),
        (pts) => {
          const ring = pts.map((p) => ({ lat: p.lat / 1e6, lng: p.lng / 1e6 }));
          expect(parseCorners(cornersText(ring))).toEqual({ ring });
        },
      ),
    );
  });

  it('a corner copied from a neighbour saved with more decimals keeps them all', () => {
    const ring = [
      { lat: 17.123456789, lng: 78.1 },
      { lat: 17.2, lng: 78.2 },
      { lat: 17.3, lng: 78.1 },
    ];
    expect(cornersText(ring).split('\n')[0]).toBe('17.123456789, 78.100000');
    expect(parseCorners(cornersText(ring))).toEqual({ ring });
  });

  it('refuses what is not a corner, and fewer than 3', () => {
    expect(parseCorners('17.4, 78.3\n17.5 78.4\n\n17.45,78.5')).toEqual({
      ring: [
        { lat: 17.4, lng: 78.3 },
        { lat: 17.5, lng: 78.4 },
        { lat: 17.45, lng: 78.5 },
      ],
    });
    expect(parseCorners('17.4, 78.3\nnorth, east\n1,2')).toEqual({
      problem: 'Line 2 is not "latitude, longitude"',
    });
    expect(parseCorners('17.4, 78.3\n95, 78.3\n1,2')).toEqual({
      problem: 'Line 2 is not "latitude, longitude"',
    });
    expect(parseCorners('17.4, 78.3')).toEqual({ problem: 'An area needs at least 3 corners' });
  });
});

// ---------------------------------------------------------------- snapping (P1.1.7)

const M_LAT = 1 / 111_195;
const M_LNG = 1 / (111_195 * Math.cos((17.45 * Math.PI) / 180));
const launch = launchAreas();
const asNeighbour = (a: AreaVersion): Neighbour => ({
  areaId: a.areaId,
  name: a.name,
  ring: a.ring,
});
const neighbours = launch.map(asNeighbour);
const madhapur = neighbours.find((n) => n.areaId === 'hyd-madhapur') as Neighbour;
const hitech = neighbours.find((n) => n.areaId === 'hyd-hitech-city') as Neighbour;
const asArea = (areaId: string, ring: readonly Corner[]): AreaVersion => ({
  areaId,
  version: 1,
  name: areaId,
  city: 'Hyderabad',
  ring,
  edgeMeters: 300,
  validFrom: '2026-11-01T00:00:00.000Z',
  draft: false,
  active: true,
});

describe('how far a corner snaps', () => {
  it('30 m when zoomed in to the streets; 12 screen pixels when zoomed out', () => {
    expect(metresPerPixel(16, 17.45)).toBeCloseTo(1.14, 2);
    expect(snapMetres(17, 17.45)).toBe(30);
    expect(snapMetres(12, 17.45)).toBeCloseTo(12 * metresPerPixel(12, 17.45), 6);
    expect(snapMetres(12, 17.45)).toBeGreaterThan(200);
  });
});

describe('snapping a corner onto a neighbour (P1.1.7)', () => {
  it('onto the corner within 30 m, exactly; onto the border, exactly on a straight one', () => {
    const near = { lat: 17.458 + 10 * M_LAT, lng: 78.387 - 12 * M_LNG };
    expect(snapCorner(near, neighbours, 30)).toMatchObject({
      point: { lat: 17.458, lng: 78.387 },
      snap: { areaId: 'hyd-madhapur', kind: 'corner', at: 3 },
    });
    const west = { lat: 17.4471234, lng: 78.387 - 20 * M_LNG };
    const s = snapCorner(west, neighbours, 30);
    expect(s.snap?.kind).toBe('border');
    expect(s.point).toEqual({ lat: 17.447123, lng: 78.387 });
    // Too far: left where it was, to 6 decimals.
    const far = { lat: 17.4471234, lng: 78.387 - 40 * M_LNG };
    expect(snapCorner(far, neighbours, 30)).toEqual({
      point: { lat: round6(far.lat), lng: round6(far.lng) },
      snap: undefined,
    });
  });

  it('the nearer neighbour wins between two', () => {
    // Between Hitech City (east 78.385) and Madhapur (west 78.387): 50 m from Hitech City.
    const p = { lat: 17.445, lng: 78.385 + 50 * M_LNG };
    expect(snapCorner(p, neighbours, 300).snap?.areaId).toBe('hyd-hitech-city');
  });

  it('property: a shape drawn with a corner snapped onto a slanted border only touches it', () => {
    // A slanted neighbour with 6-decimal corners.
    const slant: Neighbour = {
      areaId: 'hyd-slant',
      name: 'Slant',
      ring: [
        { lat: 17.5, lng: 78.5 },
        { lat: 17.5, lng: 78.53 },
        { lat: 17.523457, lng: 78.53 },
      ],
    };
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.5, max: 25, noNaN: true }),
        (f, off) => {
          // A click `off` metres north-west of the slanted side, `f` of the way along it.
          const click = {
            lat: 17.5 + f * 0.023457 + (off * M_LAT) / Math.SQRT2,
            lng: 78.5 + f * 0.03 - (off * M_LNG) / Math.SQRT2,
          };
          const s = snapCorner(click, [slant], 30);
          expect(s.snap?.kind).toBe('border');
          // The new shape: the neighbour's two slanted-side corners, the snapped point in between,
          // and one corner well outside. It touches along the slanted side and never overlaps.
          const ring: Corner[] = [
            { lat: 17.5, lng: 78.5 },
            s.point,
            { lat: 17.523457, lng: 78.53 },
            { lat: 17.523457, lng: 78.5 },
          ];
          expect(overlapSqm(ring, slant.ring)).toBeLessThan(1);
          expect(checkArea(asArea('hyd-new', ring), [asArea('hyd-slant', slant.ring)])).toEqual([]);
          expect(round6(s.point.lat)).toBe(s.point.lat);
          expect(round6(s.point.lng)).toBe(s.point.lng);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe('drawing beside a neighbour', () => {
  it('two corners snapped on the same neighbour follow its border round a bend', () => {
    // From Madhapur's west side to its north side: its north-west corner is added between.
    const a = { lat: 17.45, lng: 78.387 - 10 * M_LNG };
    const b = { lat: 17.458 + 10 * M_LAT, lng: 78.395 };
    let r = addCorner([], [], a, neighbours, 30);
    r = addCorner(r.ring, r.snaps, b, neighbours, 30);
    expect(r.ring).toEqual([
      { lat: 17.45, lng: 78.387 },
      { lat: 17.458, lng: 78.387 },
      { lat: 17.458, lng: 78.395 },
    ]);
    r = addCorner(r.ring, r.snaps, { lat: 17.465, lng: 78.395 }, neighbours, 30);
    r = addCorner(r.ring, r.snaps, { lat: 17.465, lng: 78.386 }, neighbours, 30);
    expect(checkArea(asArea('hyd-new', r.ring), launch)).toEqual([]);
    expect(sharedBorderMeters(r.ring, madhapur.ring)).toBeGreaterThan(1_700);
  });

  it('with snapping off, corners stay where they are clicked', () => {
    const r = addCorner([], [], { lat: 17.4580001234, lng: 78.387 }, neighbours, 0);
    expect(r.ring).toEqual([{ lat: 17.458, lng: 78.387 }]);
    expect(r.snap).toBeUndefined();
  });

  it('the shorter way round, whichever direction the corners go', () => {
    const at = (x: number, point: Corner): Snap => ({
      areaId: 'hyd-madhapur',
      name: 'Madhapur',
      kind: 'border',
      at: x,
      point,
    });
    // Corners: 0 SW, 1 SE, 2 NE, 3 NW. From the west side (3.5) to the south side (0.5): via SW.
    expect(
      traceBetween(
        madhapur.ring,
        at(3.5, { lat: 17.448, lng: 78.387 }),
        at(0.5, { lat: 17.438, lng: 78.3945 }),
      ),
    ).toEqual([madhapur.ring[0]]);
    expect(
      traceBetween(
        madhapur.ring,
        at(0.5, { lat: 17.438, lng: 78.3945 }),
        at(3.5, { lat: 17.448, lng: 78.387 }),
      ),
    ).toEqual([madhapur.ring[0]]);
    expect(
      traceBetween(
        madhapur.ring,
        at(3.2, { lat: 17.454, lng: 78.387 }),
        at(3.7, { lat: 17.444, lng: 78.387 }),
      ),
    ).toEqual([]);
  });

  it('"close the gap": Hitech City moves its east side onto Madhapur and passes the rules', () => {
    const before = ringGap(hitech.ring, madhapur.ring).meters;
    expect(before).toBeGreaterThan(200);
    const closed = closeGap(hitech.ring, madhapur, before + 100);
    expect(closed).toHaveLength(4);
    expect(closed.filter((p) => p.lng === 78.387)).toHaveLength(2);
    expect(ringGap(closed, madhapur.ring).meters).toBe(0);
    expect(sharedBorderMeters(closed, madhapur.ring)).toBeCloseTo(0.017 / M_LAT, -1);
    const others = launch.filter((a) => a.areaId !== 'hyd-hitech-city');
    expect(checkArea(asArea('hyd-hitech-city', closed), others)).toEqual([]);
  });

  it('"close the gap" follows the neighbour round its corners', () => {
    // A box to the north-west of Madhapur's north-west corner, 100 m off both sides of it.
    const box: Corner[] = [
      { lat: 17.441, lng: 78.38 },
      { lat: 17.441, lng: 78.387 - 100 * M_LNG },
      { lat: 17.458 + 100 * M_LAT, lng: 78.395 },
      { lat: 17.47, lng: 78.395 },
      { lat: 17.47, lng: 78.38 },
    ];
    const closed = closeGap(box, madhapur, 200);
    expect(closed).toContainEqual({ lat: 17.458, lng: 78.387 });
    expect(overlapSqm(closed, madhapur.ring)).toBeLessThan(1);
    expect(sharedBorderMeters(closed, madhapur.ring)).toBeGreaterThan(1_500);
  });
});
