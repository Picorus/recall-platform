// P7.2 (load test): area shapes and price books are read for every play judged, about 500 times a
// second with the whole fleet, and parsing every area's shape each time was most of an upload's
// work. Both tables are append-only (a change is always a new row), so their row counts say
// exactly whether anything changed: one tiny query, and the parsed copy is reused until it does.
// Kept per database (tests run many databases in one process).
import type { AreaVersion, PriceBook } from '@recall/domain';
import type { Pool } from 'pg';
import { allAreaVersions } from './areas.js';
import { priceBooks } from './bookings.js';

type Q = Pick<Pool, 'query'>;

interface Kept {
  areasKey: string;
  areas: AreaVersion[];
  booksKey: string;
  books: PriceBook[];
}
const kept = new Map<string, Kept>();

/** Area versions and price books as stored, re-read only when a row was added since. */
export async function rulesNow(c: Q): Promise<{ areas: AreaVersion[]; books: PriceBook[] }> {
  const r = await c.query<{ db: string; a: string; p: string }>(
    `SELECT current_database() AS db, (SELECT count(*) FROM area_versions) AS a,
            (SELECT count(*) FROM price_books) AS p`,
  );
  const row = r.rows[0];
  if (!row) return { areas: await allAreaVersions(c), books: await priceBooks(c) };
  const k = kept.get(row.db);
  const areas = k && k.areasKey === row.a ? k.areas : await allAreaVersions(c);
  const books = k && k.booksKey === row.p ? k.books : await priceBooks(c);
  kept.set(row.db, { areasKey: row.a, areas, booksKey: row.p, books });
  return { areas, books };
}
