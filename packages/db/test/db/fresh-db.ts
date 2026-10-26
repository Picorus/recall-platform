// Each test file gets its own new, empty database, migrated from scratch, and drops it afterwards.
// Needs DATABASE_URL pointing at the laptop database (pnpm services:up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/migrate.js';

export async function freshDatabase(): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error('DATABASE_URL is not set: start the laptop services (pnpm services:up)');
  const name = `recall_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const testUrl = new URL(url);
  testUrl.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString(), max: 8 });
  // Dropping the database at the end cuts any connection still open: expected, not a failure.
  pool.on('error', () => {});
  await migrate(pool);
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * A rider ready for a screen (P3.11), written straight in for tests about screens: on the record,
 * approved, riding the bike `plate`. (The real way, with documents and checks, is riders.test.ts.)
 */
export async function approvedRider(pool: pg.Pool, riderId: string, plate: string): Promise<void> {
  const n = Number(riderId.slice(3));
  await pool.query(
    `INSERT INTO riders (rider_id, channel, created_by, created_at) VALUES ($1, 'admin', 'test', now())`,
    [riderId],
  );
  await pool.query(
    `INSERT INTO rider_versions (rider_id, version, name, phone, bike_plate, rides, apps, reason, set_by, set_at)
     VALUES ($1, 1, 'Test Rider', $2, $3, '', '{}', 'test', 'test', now())`,
    [riderId, `+919${String(n).padStart(9, '0')}`, plate],
  );
  await pool.query(
    `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
     VALUES ($1, 1, 'applied', 'test', 'test', now()), ($1, 2, 'approved', 'test', 'test', now())`,
    [riderId],
  );
}
