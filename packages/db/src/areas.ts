// Areas in the database (P1.1). The rules live in @recall/domain; this file only stores and loads,
// and makes sure two people saving at the same moment cannot both slip past the overlap check.
import { AreaError, checkArea, parseUtcIso, type AreaVersion, type Ring } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';

interface Row {
  area_id: string;
  version: number;
  name: string;
  city: string;
  shape: string; // GeoJSON
  edge_m: number;
  valid_from: Date;
  draft: boolean;
  active: boolean;
}

const COLUMNS = `area_id, version, name, city, ST_AsGeoJSON(shape) AS shape, edge_m, valid_from, draft, active`;

function toArea(r: Row): AreaVersion {
  const coords =
    (JSON.parse(r.shape) as { coordinates: [number, number][][] }).coordinates[0] ?? [];
  // GeoJSON repeats the first corner at the end and lists longitude first.
  const ring: Ring = coords.slice(0, -1).map(([lng, lat]) => ({ lat, lng }));
  return {
    areaId: r.area_id,
    version: r.version,
    name: r.name,
    city: r.city,
    ring,
    edgeMeters: r.edge_m,
    validFrom: r.valid_from.toISOString(),
    draft: r.draft,
    active: r.active,
  };
}

function toWkt(ring: Ring): string {
  const first = ring[0];
  const points = [...ring, ...(first ? [first] : [])].map((p) => `${p.lng} ${p.lat}`);
  return `SRID=4326;POLYGON((${points.join(', ')}))`;
}

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Saves a new area version (a new area, a change, or on/off). Checks it against every other area's
 * versions that apply at or after its start, under a lock so saves happen one at a time.
 */
export async function saveAreaVersion(
  pool: Pool,
  area: AreaVersion,
  savedBy: string,
): Promise<void> {
  if (Number.isNaN(parseUtcIso(area.validFrom))) {
    throw new AreaError([{ kind: 'bad-date', detail: 'validFrom must be a UTC time' }]);
  }
  await inTransaction(pool, async (c) => {
    await c.query('SET LOCAL ROLE recall_app');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['area_versions']);
    const others = await c.query<Row>(
      `SELECT ${COLUMNS} FROM area_versions a
        WHERE a.area_id <> $1
          AND (a.valid_from > $2 OR a.version = (
                SELECT max(b.version) FROM area_versions b
                 WHERE b.area_id = a.area_id AND b.valid_from <= $2))`,
      [area.areaId, area.validFrom],
    );
    const problems = checkArea(area, others.rows.map(toArea));
    if (problems.length > 0) throw new AreaError(problems);
    await c.query(
      `INSERT INTO area_versions (area_id, version, name, city, shape, edge_m, valid_from, draft, active, saved_by)
       VALUES ($1, $2, $3, $4, ST_GeogFromText($5), $6, $7, $8, $9, $10)`,
      [
        area.areaId,
        area.version,
        area.name,
        area.city,
        toWkt(area.ring),
        area.edgeMeters,
        area.validFrom,
        area.draft,
        area.active,
        savedBy,
      ],
    );
  });
}

/** Every version of one area, oldest first. */
export async function areaHistory(pool: Pool, areaId: string): Promise<AreaVersion[]> {
  const r = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM area_versions WHERE area_id = $1 ORDER BY version`,
    [areaId],
  );
  return r.rows.map(toArea);
}

/** The version of every area in force at `instant` (UTC ISO), on or off. */
export async function areasAt(pool: Pool, instant: string): Promise<AreaVersion[]> {
  if (Number.isNaN(parseUtcIso(instant))) throw new RangeError(`Not a UTC time: ${instant}`);
  const r = await pool.query<Row>(
    `SELECT DISTINCT ON (area_id) ${COLUMNS} FROM area_versions
      WHERE valid_from <= $1 ORDER BY area_id, version DESC`,
    [instant],
  );
  return r.rows.map(toArea);
}
