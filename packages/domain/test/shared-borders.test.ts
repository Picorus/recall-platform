// P1.1.7: neighbouring areas may share a border, but their insides never overlap (Prateek, 29 Oct
// 2026). The overlap test, shared borders, gaps, and where a point on a shared border belongs, with
// the shared cases the Kotlin player must match (test-vectors/areas-locate.json). Regenerate after
// a deliberate change with:
//   UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import fc from 'fast-check';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAreaIndex, locateIndexed } from '../src/area-index.js';
import {
  checkArea,
  createArea,
  locate,
  neighboursOf,
  ON_BORDER_M,
  placeKey,
  type AreaVersion,
} from '../src/areas.js';
import {
  distanceToBorderMeters,
  MAX_OVERLAP_SQM,
  overlapSqm,
  pointInRing,
  ringAreaSqm,
  ringGap,
  ringOverlap,
  sharedBorderMeters,
  type LatLng,
  type Ring,
} from '../src/geo.js';
import { launchAreas } from '../src/launch-areas.js';

const FILE = new URL('../test-vectors/areas-locate.json', import.meta.url);
const T0 = '2026-11-01T00:00:00.000Z';
const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
/** Metres to degrees near 17.4° N. */
const M_LAT = 1 / 111_195;
const M_LNG = 1 / (111_195 * Math.cos((17.41 * Math.PI) / 180));
const area = (areaId: string, ring: Ring, over: Partial<AreaVersion> = {}): AreaVersion => ({
  areaId,
  version: 1,
  name: areaId,
  city: 'Hyderabad',
  ring,
  edgeMeters: 300,
  validFrom: T0,
  draft: false,
  active: true,
  ...over,
});

describe('overlap of the insides (P1.1.7)', () => {
  const a = box(17.4, 78.4, 17.41, 78.41);

  it('none when shapes share a whole border, part of one, or one corner', () => {
    expect(overlapSqm(a, box(17.4, 78.41, 17.41, 78.42))).toBeLessThan(1e-6);
    expect(overlapSqm(a, box(17.41, 78.4, 17.42, 78.41))).toBeLessThan(1e-6);
    expect(overlapSqm(a, box(17.402, 78.41, 17.405, 78.43))).toBeLessThan(1e-6);
    expect(overlapSqm(a, box(17.41, 78.41, 17.42, 78.42))).toBeLessThan(1e-6);
    expect(overlapSqm(a, box(17.5, 78.5, 17.51, 78.51))).toBe(0);
  });

  it('the overlapping area when insides overlap, either way round; a shape inside another', () => {
    const b = box(17.405, 78.405, 17.415, 78.415);
    // Within 0.01%: each shape is flattened around its own first corner.
    const near = (got: number, want: number) =>
      expect(Math.abs(got - want)).toBeLessThan(want * 1e-4);
    const quarter = ringAreaSqm(box(17.405, 78.405, 17.41, 78.41));
    near(overlapSqm(a, b), quarter);
    near(overlapSqm(b, a), quarter);
    const small = box(17.402, 78.402, 17.403, 78.403);
    near(overlapSqm(a, small), ringAreaSqm(small));
    near(overlapSqm(a, a), ringAreaSqm(a));
  });

  it('works for shapes that are not convex (an L and a box in its corner)', () => {
    // An L: the box a without its north-east quarter.
    const l: Ring = [
      { lat: 17.4, lng: 78.4 },
      { lat: 17.4, lng: 78.41 },
      { lat: 17.405, lng: 78.41 },
      { lat: 17.405, lng: 78.405 },
      { lat: 17.41, lng: 78.405 },
      { lat: 17.41, lng: 78.4 },
    ];
    const notch = box(17.405, 78.405, 17.41, 78.41);
    expect(overlapSqm(l, notch)).toBeLessThan(1e-6);
    expect(overlapSqm(notch, l)).toBeLessThan(1e-6);
    // Fills the notch and 10 m beyond on its west side: overlap = 10 m × the notch's height.
    const wider = box(17.405, 78.405 - 10 * M_LNG, 17.41, 78.41);
    const height = 0.005 / M_LAT;
    expect(overlapSqm(l, wider)).toBeCloseTo(10 * height, -1);
    expect(ringOverlap(l, wider).pieces.length).toBeGreaterThan(0);
  });

  it('property: for boxes, the same as the exact rectangle overlap', () => {
    const edge = fc.integer({ min: 0, max: 2000 }).map((n) => n / 100_000);
    fc.assert(
      fc.property(
        edge,
        edge,
        edge,
        edge,
        edge,
        edge,
        edge,
        edge,
        (a1, a2, a3, a4, b1, b2, b3, b4) => {
          const [s1, n1] = [Math.min(a1, a2), Math.max(a1, a2) + 0.0001];
          const [w1, e1] = [Math.min(a3, a4), Math.max(a3, a4) + 0.0001];
          const [s2, n2] = [Math.min(b1, b2), Math.max(b1, b2) + 0.0001];
          const [w2, e2] = [Math.min(b3, b4), Math.max(b3, b4) + 0.0001];
          const ra = box(17.4 + s1, 78.4 + w1, 17.4 + n1, 78.4 + e1);
          const rb = box(17.4 + s2, 78.4 + w2, 17.4 + n2, 78.4 + e2);
          const h = Math.max(0, Math.min(n1, n2) - Math.max(s1, s2)) / M_LAT;
          const w =
            (Math.max(0, Math.min(e1, e2) - Math.max(w1, w2)) / M_LNG) *
            (Math.cos((17.4 * Math.PI) / 180) / Math.cos((17.41 * Math.PI) / 180));
          const exact = h * w;
          const got = overlapSqm(ra, rb);
          expect(Math.abs(got - exact)).toBeLessThan(Math.max(1, exact * 0.005));
          expect(Math.abs(overlapSqm(rb, ra) - got)).toBeLessThan(Math.max(0.5, got * 2e-4));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it('property: a shape cut in two along any zigzag gives two halves that touch and never overlap', () => {
    // A 2 km box cut north to south by a random zigzag; corners to 6 decimals, as the Areas page keeps them.
    const six = (x: number) => Math.round(x * 1e6) / 1e6;
    const cut = fc.array(fc.integer({ min: 100, max: 1900 }), { minLength: 1, maxLength: 12 });
    fc.assert(
      fc.property(cut, (xs) => {
        const s = 17.4;
        const n = s + 2000 * M_LAT;
        const w = 78.4;
        const e = w + 2000 * M_LNG;
        const line = xs.map((x, i) => ({
          lat: six(s + ((i + 1) / (xs.length + 1)) * (n - s)),
          lng: six(w + x * M_LNG),
        }));
        const bottom = { lat: s, lng: six(w + 1000 * M_LNG) };
        const top = { lat: six(n), lng: six(w + 1000 * M_LNG) };
        const west: Ring = [{ lat: s, lng: w }, bottom, ...line, top, { lat: six(n), lng: w }];
        const east: Ring = [
          bottom,
          { lat: s, lng: six(e) },
          { lat: six(n), lng: six(e) },
          top,
          ...[...line].reverse(),
        ];
        const sqm = overlapSqm(west, east);
        expect(sqm).toBeLessThan(0.01);
        const a = area('hyd-west', west);
        const b = area('hyd-east', east);
        expect(checkArea(a, [b])).toEqual([]);
        expect(checkArea(b, [a])).toEqual([]);
        // Moved 2 m east, the zigzag's corners make the west half overlap the east one.
        const pushed = west.map((p) => (line.includes(p) ? { ...p, lng: p.lng + 2 * M_LNG } : p));
        expect(overlapSqm(pushed, east)).toBeGreaterThan(MAX_OVERLAP_SQM);
      }),
      { numRuns: 300 },
    );
  });
});

describe('saving neighbours that touch (P1.1.7)', () => {
  const a = createArea(
    {
      areaId: 'hyd-a',
      name: 'A',
      city: 'Hyderabad',
      ring: box(17.4, 78.4, 17.41, 78.41),
      validFrom: T0,
    },
    [],
  );

  it('a shared border or a shared corner may be saved', () => {
    expect(checkArea(area('hyd-b', box(17.4, 78.41, 17.41, 78.42)), [a])).toEqual([]);
    expect(checkArea(area('hyd-c', box(17.41, 78.41, 17.42, 78.42)), [a])).toEqual([]);
    expect(checkArea(area('hyd-d', box(17.403, 78.41, 17.406, 78.42)), [a])).toEqual([]);
  });

  it('an overlap over 1 m² is refused, naming the area and the square metres', () => {
    // 2 m into a along its 1.06 km east border: about 2,100 m².
    const b = area('hyd-b', box(17.4, 78.41 - 2 * M_LNG, 17.41, 78.42));
    const problems = checkArea(b, [a]);
    expect(problems).toHaveLength(1);
    const p = problems[0];
    expect(p?.kind === 'overlap' && p.withAreaId).toBe('hyd-a');
    expect(p?.kind === 'overlap' && p.sqm).toBeGreaterThan(2_000);
    expect(p?.kind === 'overlap' && p.sqm).toBeLessThan(2_300);
  });

  it('floating-point dust under 1 m² along a shared border is not an overlap', () => {
    // 0.5 mm into a along 1 km: about 0.5 m².
    const b = area('hyd-b', box(17.4, 78.41 - 0.0005 * M_LNG, 17.41, 78.42));
    expect(overlapSqm(b.ring, a.ring)).toBeGreaterThan(0.1);
    expect(checkArea(b, [a])).toEqual([]);
  });

  it('one problem per neighbour, even when two of its versions are in force', () => {
    const a2 = { ...a, version: 2, draft: true };
    const b = area('hyd-b', box(17.405, 78.405, 17.415, 78.415));
    expect(checkArea(b, [a, a2]).filter((p) => p.kind === 'overlap')).toHaveLength(1);
  });
});

describe('shared border and gaps, for the Areas page', () => {
  it('each neighbour within 1 km: its gap, shared border or overlap; off areas and far ones left out', () => {
    const me = box(17.4, 78.4, 17.41, 78.41);
    const others = [
      area('hyd-east', box(17.4, 78.41, 17.41, 78.42)),
      area('hyd-north', box(17.41 + 100 * M_LAT, 78.4, 17.42, 78.41)),
      area('hyd-over', box(17.395, 78.395, 17.401, 78.401)),
      area('hyd-off', box(17.41, 78.41, 17.42, 78.42), { active: false }),
      area('hyd-far', box(17.5, 78.5, 17.51, 78.51)),
    ];
    const n = neighboursOf(me, others);
    expect(n.map((x) => x.areaId)).toEqual(['hyd-east', 'hyd-over', 'hyd-north']);
    expect(n[0]).toMatchObject({
      gapMeters: 0,
      gap: null,
      overlapSqm: expect.any(Number) as number,
    });
    expect(n[0]?.sharedMeters).toBeCloseTo(0.01 / M_LAT, -1);
    expect(n[1]?.overlapSqm).toBeGreaterThan(10_000);
    expect(n[1]?.overlap.length).toBeGreaterThan(0);
    expect(n[2]?.gapMeters).toBeCloseTo(100, 0);
    expect(n[2]?.gap?.from.lat).toBeCloseTo(17.41, 6);
  });

  it('the length of border two areas share', () => {
    const a = box(17.4, 78.4, 17.41, 78.41);
    expect(sharedBorderMeters(a, box(17.4, 78.41, 17.41, 78.42))).toBeCloseTo(0.01 / M_LAT, -1);
    expect(sharedBorderMeters(a, box(17.405, 78.41, 17.42, 78.42))).toBeCloseTo(0.005 / M_LAT, -1);
    expect(sharedBorderMeters(a, box(17.41, 78.41, 17.42, 78.42))).toBe(0);
    expect(sharedBorderMeters(a, box(17.5, 78.5, 17.51, 78.51))).toBe(0);
  });

  it('the gap between the launch areas Hitech City and Madhapur is about 212 m', () => {
    const areas = launchAreas();
    const ring = (id: string) => areas.find((x) => x.areaId === id)?.ring ?? [];
    const g = ringGap(ring('hyd-hitech-city'), ring('hyd-madhapur'));
    expect(g.meters).toBeCloseTo(0.002 / M_LNG, -1);
    expect(g.from.lng).toBeCloseTo(78.385, 6);
    expect(g.to.lng).toBeCloseTo(78.387, 6);
    expect(ringGap(box(17.4, 78.4, 17.41, 78.41), box(17.4, 78.41, 17.41, 78.42)).meters).toBe(0);
  });
});

// ---------------------------------------------------------------- where a point on a border belongs

/** Four boxes meeting at one corner, two triangles sharing a slanted border, and an area that is off. */
const AREAS: AreaVersion[] = [
  area('hyd-d', box(17.41, 78.41, 17.42, 78.42)),
  area('hyd-b', box(17.4, 78.41, 17.41, 78.42), { version: 3, edgeMeters: 200 }),
  area('hyd-s2', [
    { lat: 17.43, lng: 78.4 },
    { lat: 17.45, lng: 78.42 },
    { lat: 17.45, lng: 78.4 },
  ]),
  area('hyd-a', box(17.4, 78.4, 17.41, 78.41)),
  area('hyd-c', box(17.41, 78.4, 17.42, 78.41)),
  area('hyd-s1', [
    { lat: 17.43, lng: 78.4 },
    { lat: 17.43, lng: 78.42 },
    { lat: 17.45, lng: 78.42 },
  ]),
  area('hyd-off', box(17.401, 78.401, 17.409, 78.419), { active: false }),
];

/** A point `f` of the way along the slanted border, then `m` metres to its north-west. */
const onSlant = (f: number, m = 0): LatLng => ({
  lat: 17.43 + f * 0.02 + (m * M_LAT) / Math.SQRT2,
  lng: 78.4 + f * 0.02 - (m * M_LNG) / Math.SQRT2,
});

const POINTS: { name: string; at: LatLng }[] = [
  { name: 'on the border a and b share (north to south)', at: { lat: 17.405, lng: 78.41 } },
  { name: 'on the border a and c share (east to west)', at: { lat: 17.41, lng: 78.405 } },
  { name: 'the corner all four boxes share', at: { lat: 17.41, lng: 78.41 } },
  { name: 'on the border b and d share', at: { lat: 17.41, lng: 78.415 } },
  { name: 'on the border c and d share', at: { lat: 17.415, lng: 78.41 } },
  { name: 'half way along the slanted border', at: onSlant(0.5) },
  { name: '37% along the slanted border (not exact in floating point)', at: onSlant(0.37) },
  { name: '0.5 mm off the slanted border, towards s2', at: onSlant(0.61, 0.0005) },
  { name: '2 mm off the slanted border, inside s2', at: onSlant(0.61, 0.002) },
  { name: '2 mm off the slanted border, inside s1', at: onSlant(0.61, -0.002) },
  { name: '5 m inside b, in a’s edge zone', at: { lat: 17.405, lng: 78.41 + 5 * M_LNG } },
  { name: '5 m inside a, in b’s edge zone', at: { lat: 17.405, lng: 78.41 - 5 * M_LNG } },
  { name: 'on a’s outer border (no neighbour there)', at: { lat: 17.405, lng: 78.4 } },
  { name: '50 m east of b (its edge zone is 200 m)', at: { lat: 17.405, lng: 78.42 + 50 * M_LNG } },
  { name: '250 m east of b (beyond its edge zone)', at: { lat: 17.405, lng: 78.42 + 250 * M_LNG } },
  {
    name: '100 m south of where a and b meet: as near to both, the smaller id',
    at: { lat: 17.4 - 100 * M_LAT, lng: 78.41 },
  },
  { name: '100 m south of b, nearer b than a', at: { lat: 17.4 - 100 * M_LAT, lng: 78.412 } },
  { name: 'inside the area that is off, inside a', at: { lat: 17.405, lng: 78.405 } },
  {
    name: 'between the boxes and the triangles, 50 m below s1',
    at: { lat: 17.43 - 50 * M_LAT, lng: 78.41 },
  },
  { name: 'far away', at: { lat: 17.3, lng: 78.3 } },
];

describe('where a point on a shared border belongs (P1.1.7)', () => {
  const expectedOf = (p: LatLng) => {
    const place = locate(p, AREAS);
    return {
      place: placeKey(place),
      metersOutside: place.kind === 'edge' ? Math.round(place.metersOutside * 1e6) / 1e6 : null,
    };
  };
  const vectors = {
    notes: [
      'Areas are given unsorted: order by areaId (code unit by code unit) before checking.',
      `Inside (point-in-ring and more than ${ON_BORDER_M} m from the border) wins; then on a border (within ${ON_BORDER_M} m): the smaller id; then the nearer edge zone (nearer by more than ${ON_BORDER_M} m; otherwise the smaller id).`,
      'metersOutside is rounded to 6 decimals; compare within 1e-6.',
    ],
    onBorderM: ON_BORDER_M,
    areas: AREAS.map(({ areaId, version, ring, edgeMeters, active }) => ({
      areaId,
      version,
      ring,
      edgeMeters,
      active,
    })),
    cases: POINTS.map((p) => ({ name: p.name, lat: p.at.lat, lng: p.at.lng, ...expectedOf(p.at) })),
  };
  const text = `${JSON.stringify(vectors, null, 1)}\n`;
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE)) writeFileSync(FILE, text);

  it('the shared cases are up to date (UPDATE_VECTORS=1 to regenerate after a deliberate change)', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('give exactly the answers the rule says', () => {
    const got = Object.fromEntries(vectors.cases.map((c) => [c.name, c.place]));
    expect(Object.values(got)).toEqual([
      'inside:hyd-a@1',
      'inside:hyd-a@1',
      'inside:hyd-a@1',
      'inside:hyd-b@3',
      'inside:hyd-c@1',
      'inside:hyd-s1@1',
      'inside:hyd-s1@1',
      'inside:hyd-s1@1',
      'inside:hyd-s2@1',
      'inside:hyd-s1@1',
      'inside:hyd-b@3',
      'inside:hyd-a@1',
      'inside:hyd-a@1',
      'edge:hyd-b@3',
      'outside',
      'edge:hyd-a@1',
      'edge:hyd-b@3',
      'inside:hyd-a@1',
      'edge:hyd-s1@1',
      'outside',
    ]);
  });

  it('the shapes in the cases touch and never overlap', () => {
    for (const a of AREAS) expect(checkArea(a, AREAS)).toEqual([]);
  });

  const near = fc.record({
    lat: fc.double({ min: 17.395, max: 17.455, noNaN: true }),
    lng: fc.double({ min: 78.395, max: 78.425, noNaN: true }),
  });

  it('property: inside an area always wins over another area’s edge zone', () => {
    fc.assert(
      fc.property(near, (p) => {
        const place = locate(p, AREAS);
        for (const a of AREAS.filter((x) => x.active)) {
          const inside = pointInRing(p, a.ring) && distanceToBorderMeters(p, a.ring) > ON_BORDER_M;
          if (inside) expect(placeKey(place)).toBe(`inside:${a.areaId}@${a.version}`);
        }
      }),
      { numRuns: 20_000 },
    );
  });

  it('property: one answer whatever order the areas come in, and the fast lookup agrees', () => {
    const index = buildAreaIndex(AREAS);
    fc.assert(
      fc.property(near, fc.integer({ min: 0, max: 10_000 }), (p, seed) => {
        const shuffled = [...AREAS].sort(
          (x, y) => ((x.areaId.length * 7919 + seed) % 13) - ((y.areaId.length * 7919 + seed) % 13),
        );
        expect(locate(p, shuffled)).toEqual(locate(p, AREAS));
        expect(locateIndexed(p, index)).toEqual(locate(p, AREAS));
      }),
      { numRuns: 5_000 },
    );
  });

  it('property: any point on a shared border belongs to exactly one of the two, the smaller id', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (f) => {
        expect(placeKey(locate(onSlant(f), AREAS))).toBe('inside:hyd-s1@1');
        const ab = { lat: 17.4 + f * 0.01, lng: 78.41 };
        expect(placeKey(locate(ab, AREAS))).toBe('inside:hyd-a@1');
      }),
      { numRuns: 5_000 },
    );
  });
});
