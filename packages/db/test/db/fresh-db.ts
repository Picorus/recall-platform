// Each test file gets its own new, empty database, migrated from scratch, and drops it afterwards.
// Needs DATABASE_URL pointing at the laptop database (pnpm services:up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { PayoutDestination } from '@recall/adapters';
import { migrate } from '../../src/migrate.js';
import { accountPrint } from '../../src/rider-checks.js';

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

/**
 * Where a rider is paid, as a passed ₹1 check leaves it (P3.11.2), written straight in for tests
 * about payouts: the rider on record (approved) if he is not yet, the check, the account.
 */
export async function checkedPayoutAccount(
  pool: pg.Pool,
  riderId: string,
  to: PayoutDestination,
): Promise<void> {
  const known = await pool.query('SELECT 1 FROM riders WHERE rider_id = $1', [riderId]);
  if (!known.rowCount) await approvedRider(pool, riderId, `TS${riderId.slice(3)}`);
  const checkId = `CHK-${randomBytes(5).toString('hex').toUpperCase()}`;
  await pool.query(
    `INSERT INTO rider_checks (check_id, rider_id, kind, provider_ref, about, started_by, started_at)
     VALUES ($1, $2, 'bank', 'test', $3, 'test', now())`,
    [checkId, riderId, accountPrint(to)],
  );
  await pool.query(
    `INSERT INTO rider_check_results (check_id, outcome, name, at) VALUES ($1, 'passed', $2, now())`,
    [checkId, to.name],
  );
  await pool.query(
    `INSERT INTO rider_payout_accounts (rider_id, destination, set_by) VALUES ($1, $2, 'test')`,
    [riderId, JSON.stringify(to)],
  );
}
