import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildAreaIndex, locateIndexed } from '../src/area-index.js';
import {
  AreaError,
  checkArea,
  createArea,
  DEFAULT_EDGE_METERS,
  locate,
  reviseArea,
  setAreaActive,
  othersInForce,
  publishedAt,
  versionAt,
  type AreaVersion,
} from '../src/areas.js';
import { distanceMeters, type Ring } from '../src/geo.js';
import { launchAreas } from '../src/launch-areas.js';

const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
const T0 = '2026-11-01T00:00:00.000Z';
const T1 = '2026-12-01T00:00:00.000Z';
const new_ = (areaId: string, ring: Ring, edgeMeters?: number) => ({
  areaId,
  name: areaId,
  city: 'Hyderabad',
  ring,
  validFrom: T0,
  ...(edgeMeters === undefined ? {} : { edgeMeters }),
});

describe('saving an area', () => {
  it('starts at version 1 with the default 300 m edge zone', () => {
    const a = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
    expect(a.version).toBe(1);
    expect(a.edgeMeters).toBe(DEFAULT_EDGE_METERS);
    expect(DEFAULT_EDGE_METERS).toBe(300);
  });

  it('refuses overlap, a crossed border, a bad edge zone, a bad id and a duplicate id', () => {
    const a = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
    const kinds = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as AreaError).problems.map((p) => p.kind);
      }
      return [];
    };
    expect(kinds(() => createArea(new_('hyd-b', box(17.405, 78.405, 17.42, 78.42)), [a]))).toEqual([
      'overlap',
    ]);
    const bowtie: Ring = [
      { lat: 17.5, lng: 78.5 },
      { lat: 17.51, lng: 78.51 },
      { lat: 17.5, lng: 78.51 },
      { lat: 17.51, lng: 78.5 },
    ];
    expect(kinds(() => createArea(new_('hyd-c', bowtie), [a]))).toEqual(['bad-shape']);
    expect(
      kinds(() => createArea(new_('hyd-d', box(17.5, 78.5, 17.51, 78.51), 2_001), [a])),
    ).toEqual(['bad-edge']);
    expect(kinds(() => createArea(new_('Hyd D', box(17.5, 78.5, 17.51, 78.51)), [a]))).toEqual([
      'bad-id',
    ]);
    expect(kinds(() => createArea(new_('hyd-a', box(17.5, 78.5, 17.51, 78.51)), [a]))).toEqual([
      'bad-id',
    ]);
  });

  it('edge zones may overlap; shapes may not', () => {
    const a = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
    // 100 m apart: edge zones (300 m) overlap, shapes do not.
    const b = createArea(new_('hyd-b', box(17.4109, 78.4, 17.42, 78.41)), [a]);
    expect(checkArea(b, [a])).toEqual([]);
  });
});

describe('versions (P1.1.2)', () => {
  const v1 = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
  const v2 = reviseArea([v1], { ring: box(17.4, 78.4, 17.42, 78.41), edgeMeters: 200 }, T1, []);

  it('a change makes the next version and leaves the old one as it was', () => {
    expect(v2.version).toBe(2);
    expect(v1.version).toBe(1);
    expect(v1.ring).toEqual(box(17.4, 78.4, 17.41, 78.41));
    expect(v1.edgeMeters).toBe(300);
  });

  it('a booking made under version 1 still finds version 1 at its time', () => {
    expect(versionAt([v1, v2], '2026-11-15T10:00:00.000Z')?.version).toBe(1);
    expect(versionAt([v1, v2], '2026-12-15T10:00:00.000Z')?.version).toBe(2);
    expect(versionAt([v1, v2], '2026-10-01T00:00:00.000Z')).toBeUndefined();
  });

  it('a new version must start after the one it replaces', () => {
    expect(() => reviseArea([v1], { name: 'A' }, T0, [])).toThrow(AreaError);
  });

  it('a revision is checked against the other areas', () => {
    const other = createArea(new_('hyd-b', box(17.415, 78.4, 17.43, 78.41)), [v1]);
    expect(() => reviseArea([v1], { ring: box(17.4, 78.4, 17.42, 78.41) }, T1, [other])).toThrow(
      AreaError,
    );
  });
});

describe('where is a point (P1.1.4)', () => {
  const a = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
  const b = createArea(new_('hyd-b', box(17.4109, 78.4, 17.42, 78.41)), [a]);

  it('inside, in the edge zone, or outside', () => {
    expect(locate({ lat: 17.405, lng: 78.405 }, [a, b])).toEqual({
      kind: 'inside',
      areaId: 'hyd-a',
      version: 1,
    });
    const edge = locate({ lat: 17.405, lng: 78.4119 }, [a, b]);
    expect(edge.kind).toBe('edge');
    expect(edge.kind === 'edge' && edge.metersOutside).toBeCloseTo(201.7, 0);
    expect(locate({ lat: 17.405, lng: 78.42 }, [a, b])).toEqual({ kind: 'outside' });
  });

  it('a point in two edge zones goes to the nearer area', () => {
    // Gap runs from 17.4100 to 17.4109 (about 100 m); 30 m above a, 70 m below b.
    const near = locate({ lat: 17.41027, lng: 78.405 }, [a, b]);
    expect(near.kind === 'edge' && near.areaId).toBe('hyd-a');
    const nearB = locate({ lat: 17.41063, lng: 78.405 }, [a, b]);
    expect(nearB.kind === 'edge' && nearB.areaId).toBe('hyd-b');
  });
});

describe('launch areas (P1.1.5)', () => {
  const areas = launchAreas();

  it('six named drafts in Hyderabad, none overlapping', () => {
    expect(areas.map((a) => a.name)).toEqual([
      'Gachibowli',
      'Kondapur',
      'Hitech City',
      'Madhapur',
      'Jubilee Hills',
      'Banjara Hills',
    ]);
    for (const a of areas) {
      expect(a.draft).toBe(true);
      expect(a.city).toBe('Hyderabad');
      expect(checkArea(a, areas)).toEqual([]);
    }
  });

  it('each sits within 20 km of the city centre (Charminar)', () => {
    for (const a of areas) {
      for (const p of a.ring) {
        expect(distanceMeters(p, { lat: 17.3616, lng: 78.4747 })).toBeLessThan(20_000);
      }
    }
  });
});

describe('fast lookup by hexagons (P1.1.3)', () => {
  const areas = launchAreas();
  const index = buildAreaIndex(areas);
  const point = fc.record({
    lat: fc.double({ min: 17.39, max: 17.5, noNaN: true }),
    lng: fc.double({ min: 78.32, max: 78.47, noNaN: true }),
  });

  it('always gives the same answer as checking every area', () => {
    fc.assert(
      fc.property(point, (p) => {
        expect(locateIndexed(p, index)).toEqual(locate(p, areas));
      }),
      { numRuns: 20_000 },
    );
  });

  it('also right next to the edge zone limit', () => {
    // Points just inside and just outside 300 m east of Madhapur.
    const m = areas.find((a) => a.areaId === 'hyd-madhapur') as AreaVersion;
    const east = Math.max(...m.ring.map((p) => p.lng));
    const metresToLng = 1 / (111_195 * Math.cos((17.448 * Math.PI) / 180));
    for (const metres of [299, 299.9, 300.1, 301]) {
      const p = { lat: 17.448, lng: east + metres * metresToLng };
      expect(locateIndexed(p, index)).toEqual(locate(p, areas));
    }
    expect(locateIndexed({ lat: 17.448, lng: east + 299 * metresToLng }, index).kind).toBe('edge');
    expect(locateIndexed({ lat: 17.448, lng: east + 301 * metresToLng }, index).kind).toBe(
      'outside',
    );
  });

  it('cells are size 9 (about 0.1 km²)', () => {
    expect(index.resolution).toBe(9);
    expect(index.cells.size).toBeGreaterThan(100);
  });
});

describe('turning areas on and off (super admin)', () => {
  const a = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
  const off = setAreaActive([a], false, T1, []);
  const inside = { lat: 17.405, lng: 78.405 };

  it('a new area is on; turning it off is a new version and the old one stays', () => {
    expect(a.active).toBe(true);
    expect(off.active).toBe(false);
    expect(off.version).toBe(2);
    expect(versionAt([a, off], '2026-11-15T00:00:00.000Z')?.active).toBe(true);
  });

  it('an area that is off is outside for counting, also in the fast lookup', () => {
    expect(locate(inside, [off]).kind).toBe('outside');
    expect(locateIndexed(inside, buildAreaIndex([off]))).toEqual({ kind: 'outside' });
  });

  it('an area that is off does not block a new one; turning it back on is checked again', () => {
    const b = createArea(new_('hyd-b', box(17.405, 78.405, 17.42, 78.42)), [off]);
    expect(() => setAreaActive([a, off], true, '2027-01-01T00:00:00.000Z', [b])).toThrow(AreaError);
    const back = setAreaActive([a, off], true, '2027-01-01T00:00:00.000Z', []);
    expect(back.active).toBe(true);
    expect(back.version).toBe(3);
  });
});

describe('review fixes', () => {
  const v1 = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);

  it('times must be exact UTC: no missing Z, no 30 February, no loose text', () => {
    for (const bad of ['2026-11-01T05:30:00', '2026-02-30T00:00:00Z', '1', '2026-11-01']) {
      expect(() =>
        createArea({ ...new_('hyd-z', box(17.5, 78.5, 17.51, 78.51)), validFrom: bad }, []),
      ).toThrow(AreaError);
      expect(() => versionAt([v1], bad)).toThrow(RangeError);
    }
  });

  it('a change always builds on the newest version, so no two versions share a number', () => {
    const v2 = reviseArea([v1], { name: 'b' }, T1, []);
    const v3 = reviseArea([v1, v2], { name: 'c' }, '2027-01-01T00:00:00.000Z', []);
    expect(v3.version).toBe(3);
    expect(() => reviseArea([v1, v2], { name: 'c' }, '2026-11-15T00:00:00.000Z', [])).toThrow(
      AreaError,
    );
  });

  it('a change that leaves a value out keeps the old value', () => {
    const v2 = reviseArea([v1], { edgeMeters: undefined, name: 'b' }, T1, []);
    expect(v2.edgeMeters).toBe(300);
  });

  it('shapes touching along a slanted border are caught', () => {
    const a = createArea(
      new_('hyd-a2', [
        { lat: 17.4, lng: 78.4 },
        { lat: 17.43, lng: 78.43 },
        { lat: 17.4, lng: 78.43 },
      ]),
      [],
    );
    const b = new_('hyd-b2', [
      { lat: 17.40195, lng: 78.40195 },
      { lat: 17.41095, lng: 78.41095 },
      { lat: 17.41645, lng: 78.39645 },
    ]);
    expect(() => createArea(b, [a])).toThrow(AreaError);
  });
});

describe('on/off with a draft pending, and which shapes a change is checked against (review P3.5)', () => {
  const T2 = '2027-01-01T00:00:00.000Z';
  const T3 = '2027-02-01T00:00:00.000Z';
  const a1 = createArea(new_('hyd-a', box(17.4, 78.4, 17.41, 78.41)), []);
  const draft = reviseArea([a1], { edgeMeters: 100, draft: true }, T1, []);

  it('turning off builds on the published shape, not the pending draft, and takes effect', () => {
    const off = setAreaActive([a1, draft], false, T2, []);
    expect(off).toMatchObject({
      version: 3,
      active: false,
      draft: false,
      edgeMeters: a1.edgeMeters,
    });
    expect(publishedAt([a1, draft, off], T3)?.active).toBe(false);
  });

  it('checked against shapes in force or coming, never old ones', () => {
    const b1 = createArea(new_('hyd-b', box(17.5, 78.5, 17.52, 78.52)), []);
    const b2 = reviseArea([b1], { ring: box(17.5, 78.5, 17.505, 78.505) }, T1, []);
    const b3 = reviseArea([b1, b2], { ring: box(17.5, 78.5, 17.506, 78.506), draft: true }, T2, []);
    const all = [a1, draft, b1, b2, b3];
    // At T3: b2 is the published shape in force; b3 the newest (a draft); b1 is history.
    expect(othersInForce(all, 'hyd-a', T3).map((v) => [v.areaId, v.version])).toEqual([
      ['hyd-b', 2],
      ['hyd-b', 3],
    ]);
    // Before T2, b3 is still to come.
    expect(othersInForce(all, 'hyd-a', '2026-12-15T00:00:00.000Z').map((v) => v.version)).toEqual([
      2, 3,
    ]);
  });
});
