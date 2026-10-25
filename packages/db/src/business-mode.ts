// The business switch in the database: POC or regular business (Prateek, 24 Oct 2026).
import { modeAt, switchCountsFrom, type BusinessMode, type ModeChange } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';

/** Every switch, oldest first. */
export async function businessModes(c: Pick<PoolClient, 'query'>): Promise<ModeChange[]> {
  const r = await c.query<{ mode: BusinessMode; from: string }>(
    'SELECT mode, extract(epoch FROM from_at)::bigint AS from FROM business_modes ORDER BY from_at',
  );
  return r.rows.map((x) => ({ mode: x.mode, from: Number(x.from) }));
}

/**
 * A super admin flips the business to POC or regular business. It counts from the start of the
 * business day it is made in; returns that moment. One switch a day.
 */
export async function setBusinessMode(
  pool: Pool,
  mode: BusinessMode,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can switch the business');
  if (mode !== 'poc' && mode !== 'regular') throw new RangeError('Mode must be poc or regular');
  return inTransaction(pool, async (c) => {
    // The pay runs take the same lock, so a switch never lands in the middle of one.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-pay'))");
    const changes = await businessModes(c);
    const from = switchCountsFrom(now);
    const last = changes[changes.length - 1];
    if (last && last.from >= from) throw new Error('The business was already switched today');
    if (modeAt(changes, from) === mode) throw new Error(`The business is already on ${mode}`);
    await c.query(
      'INSERT INTO business_modes (from_at, mode, set_by, reason) VALUES (to_timestamp($1), $2, $3, $4)',
      [from, mode, by.id, reason],
    );
    return from;
  });
}
