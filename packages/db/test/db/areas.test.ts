import {
  AreaError,
  createArea,
  launchAreas,
  reviseArea,
  setAreaActive,
  type AreaVersion,
  type Ring,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { areaHistory, areasAt, saveAreaVersion } from '../../src/areas.js';
import { migrate, readMigrations } from '../../src/migrate.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
const T0 = '2026-11-01T00:00:00.000Z';

describe('migrations', () => {
  it('a second run applies nothing', async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it('a migration edited after it ran is refused', async () => {
    const edited = readMigrations().map((m, i) => (i === 0 ? { ...m, sha256: 'changed' } : m));
    await expect(migrate(pool, edited)).rejects.toThrow(/was changed after it ran/);
  });
});

describe('areas in the database', () => {
  const launch = launchAreas(T0);

  it('the six launch areas save and load back exactly', async () => {
    for (const a of launch) await saveAreaVersion(pool, a, 'system');
    const loaded = await areasAt(pool, '2026-11-02T00:00:00.000Z');
    expect(loaded.map((a) => a.areaId).sort()).toEqual(launch.map((a) => a.areaId).sort());
    for (const a of launch) {
      const b = loaded.find((x) => x.areaId === a.areaId) as AreaVersion;
      expect({ ...b, ring: [] }).toEqual({ ...a, ring: [] });
      b.ring.forEach((p, i) => {
        expect(p.lat).toBeCloseTo(a.ring[i]?.lat ?? 0, 9);
        expect(p.lng).toBeCloseTo(a.ring[i]?.lng ?? 0, 9);
      });
    }
  });

  it('an overlapping area is refused by the same check as the domain', async () => {
    const bad = createArea(
      {
        areaId: 'hyd-overlap',
        name: 'Overlap',
        city: 'Hyderabad',
        ring: box(17.44, 78.39, 17.45, 78.395),
        validFrom: T0,
      },
      [],
    );
    await expect(saveAreaVersion(pool, bad, 'prateek')).rejects.toBeInstanceOf(AreaError);
  });

  it('versions only go forward, and the old one stays', async () => {
    const [v1] = await areaHistory(pool, 'hyd-madhapur');
    const v2 = reviseArea([v1 as AreaVersion], { edgeMeters: 200 }, '2026-12-01T00:00:00.000Z', []);
    await saveAreaVersion(pool, v2, 'arjun');
    const history = await areaHistory(pool, 'hyd-madhapur');
    expect(history.map((v) => [v.version, v.edgeMeters])).toEqual([
      [1, 300],
      [2, 200],
    ]);
    // Saving version 2 again, or skipping to 4, is refused by the database itself.
    await expect(saveAreaVersion(pool, v2, 'arjun')).rejects.toThrow();
    await expect(
      saveAreaVersion(pool, { ...v2, version: 4, validFrom: '2027-01-01T00:00:00.000Z' }, 'arjun'),
    ).rejects.toThrow(/next version must be 3/);
  });

  it('rows can never be edited or deleted, even directly', async () => {
    await expect(
      pool.query("UPDATE area_versions SET name = 'x' WHERE area_id = 'hyd-madhapur'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM area_versions WHERE area_id = 'hyd-madhapur'"),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE area_versions')).rejects.toThrow();
  });

  it('turning an area off is a new version from a date; before that date it is still on', async () => {
    const history = await areaHistory(pool, 'hyd-kondapur');
    const off = setAreaActive(history, false, '2027-02-01T00:00:00.000Z', []);
    await saveAreaVersion(pool, off, 'prateek');
    const before = await areasAt(pool, '2027-01-15T00:00:00.000Z');
    const after = await areasAt(pool, '2027-02-15T00:00:00.000Z');
    expect(before.find((a) => a.areaId === 'hyd-kondapur')?.active).toBe(true);
    expect(after.find((a) => a.areaId === 'hyd-kondapur')?.active).toBe(false);
  });

  it('two people saving overlapping new areas at the same moment: only one gets in', async () => {
    const one = createArea(
      {
        areaId: 'hyd-race-a',
        name: 'A',
        city: 'Hyderabad',
        ring: box(17.3, 78.3, 17.31, 78.31),
        validFrom: T0,
      },
      [],
    );
    const two = createArea(
      {
        areaId: 'hyd-race-b',
        name: 'B',
        city: 'Hyderabad',
        ring: box(17.305, 78.305, 17.315, 78.315),
        validFrom: T0,
      },
      [],
    );
    const results = await Promise.allSettled([
      saveAreaVersion(pool, one, 'a'),
      saveAreaVersion(pool, two, 'b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

// The overlap rule lives in the domain (checkArea, under the save lock); the database has no shape
// check of its own (no ST_Overlaps or ST_Touches anywhere). These tests ask PostGIS to confirm it.
describe('neighbours sharing a border (P1.1.7)', () => {
  const area = (areaId: string, ring: Ring): AreaVersion => ({
    areaId,
    version: 1,
    name: areaId,
    city: 'Hyderabad',
    ring,
    edgeMeters: 300,
    validFrom: T0,
    draft: false,
    active: true,
  });
  const wkt = (ring: Ring) =>
    `SRID=4326;POLYGON((${[...ring, ring[0]].map((p) => `${p?.lng} ${p?.lat}`).join(', ')}))`;
  // A slanted border, corners to 6 decimals as the Areas page keeps them.
  const slantA: Ring = [
    { lat: 17.2, lng: 78.2 },
    { lat: 17.2, lng: 78.23 },
    { lat: 17.223457, lng: 78.23 },
  ];
  const slantB: Ring = [
    { lat: 17.2, lng: 78.2 },
    { lat: 17.223457, lng: 78.23 },
    { lat: 17.223457, lng: 78.2 },
  ];

  it('touching areas save, load back exactly, and PostGIS agrees their insides never meet', async () => {
    const saved = [
      area('hyd-touch-a', box(17.25, 78.25, 17.26, 78.26)),
      area('hyd-touch-b', box(17.25, 78.26, 17.26, 78.27)), // a whole shared border
      area('hyd-touch-c', box(17.26, 78.26, 17.27, 78.27)), // a corner with a, a border with b
      area('hyd-touch-d', box(17.255, 78.24, 17.258, 78.25)), // part of a's west border
      area('hyd-slant-a', slantA),
      area('hyd-slant-b', slantB),
    ];
    for (const a of saved) await saveAreaVersion(pool, a, 'arjun', 'no gap with the neighbour');
    const loaded = await areasAt(pool, '2026-11-02T00:00:00.000Z');
    for (const a of saved) expect(loaded.find((x) => x.areaId === a.areaId)?.ring).toEqual(a.ring);
    // PostGIS's own word: the insides never meet ('2********'); the borders touch.
    const r = await pool.query<{ a: string; b: string; inner: boolean; touch: boolean }>(
      `SELECT x.area_id AS a, y.area_id AS b,
              ST_Relate(x.shape::geometry, y.shape::geometry, '2********') AS inner,
              ST_Touches(x.shape::geometry, y.shape::geometry) AS touch
         FROM area_versions x JOIN area_versions y ON x.area_id < y.area_id
        WHERE (x.area_id LIKE 'hyd-touch-%' AND y.area_id LIKE 'hyd-touch-%')
           OR (x.area_id LIKE 'hyd-slant-%' AND y.area_id LIKE 'hyd-slant-%')
        ORDER BY 1, 2`,
    );
    expect(r.rows.length).toBe(7);
    expect(r.rows.every((x) => !x.inner)).toBe(true);
    expect(r.rows.filter((x) => x.touch).map((x) => `${x.a}|${x.b}`)).toEqual([
      'hyd-slant-a|hyd-slant-b',
      'hyd-touch-a|hyd-touch-b',
      'hyd-touch-a|hyd-touch-c',
      'hyd-touch-a|hyd-touch-d',
      'hyd-touch-b|hyd-touch-c',
    ]);
  });

  it('an overlap over 1 m² is refused, and PostGIS measures about the same overlap', async () => {
    const east = 2 / (111_195 * Math.cos((17.255 * Math.PI) / 180));
    const pushed = area('hyd-touch-e', box(17.25, 78.27 - east, 17.26, 78.28));
    const err = await saveAreaVersion(pool, pushed, 'arjun').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AreaError);
    const problem = (err as AreaError).problems[0];
    expect(problem?.kind === 'overlap' && problem.withAreaId).toBe('hyd-touch-b');
    const r = await pool.query<{ sqm: number }>(
      `SELECT ST_Area(ST_Intersection(ST_GeogFromText($1), ST_GeogFromText($2))) AS sqm`,
      [wkt(pushed.ring), wkt(box(17.25, 78.26, 17.26, 78.27))],
    );
    const sqm = problem?.kind === 'overlap' ? problem.sqm : 0;
    expect(sqm).toBeGreaterThan(2_000);
    expect(Math.abs(Number(r.rows[0]?.sqm) - sqm) / sqm).toBeLessThan(0.01);
  });

  it('two people saving neighbours that touch at the same moment: both get in', async () => {
    const results = await Promise.allSettled([
      saveAreaVersion(pool, area('hyd-pair-a', box(17.15, 78.15, 17.16, 78.16)), 'a'),
      saveAreaVersion(pool, area('hyd-pair-b', box(17.15, 78.16, 17.16, 78.17)), 'b'),
    ]);
    expect(results.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
