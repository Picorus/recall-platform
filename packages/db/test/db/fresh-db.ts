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
