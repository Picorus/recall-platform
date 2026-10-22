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
