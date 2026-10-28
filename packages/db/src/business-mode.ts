// The business switch in the database: POC or regular business (Prateek, 24 Oct 2026).
import {
  DEFAULT_POC_RULES,
  modeAt,
  pocDaysEarly,
  pocEndedAt,
  pocPhase,
  pocStartsFrom,
  switchCountsFrom,
  type BusinessMode,
  type ModeChange,
  type PocPhase,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';

/** Whether this database is a demo copy (made-up data, for showing investors). */
export async function isDemoCopy(c: Pick<PoolClient, 'query'>): Promise<boolean> {
  return (await c.query('SELECT 1 FROM demo_copy LIMIT 1')).rows.length > 0;
}

/**
 * Marks a new, empty database as a demo copy (before the simulator fills it with made-up data).
 * Refused once it holds any booking, payment or rider, so the real system can never be marked.
 */
export async function markDemoCopy(pool: Pool, by: string): Promise<void> {
  await inTransaction(pool, async (c) => {
    const used = await c.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM bookings) OR EXISTS (SELECT 1 FROM ledger_entries)
                   OR EXISTS (SELECT 1 FROM rider_screens) OR EXISTS (SELECT 1 FROM business_modes)`,
    );
    if (used.rows.length > 0) throw new Error('Only an empty database can be made a demo copy');
    await c.query('INSERT INTO demo_copy (marked_by) VALUES ($1)', [by]);
  });
}

/** How many months the POC is planned to run (the POC package setting; alerts and the guard). */
export async function pocMonthsSetting(c: Pick<PoolClient, 'query'>): Promise<number> {
  const r = await c.query<{ value: { pocMonths?: number } }>(
    "SELECT value FROM settings WHERE key = 'poc' ORDER BY version DESC LIMIT 1",
  );
  return r.rows[0]?.value.pocMonths ?? DEFAULT_POC_RULES.pocMonths;
}

/**
 * Whether the switch can still be used: until the POC has ended (always in a demo copy). The portal shows it to the super admin only, and after the POC as a record (view only).
 */
export async function canSwitch(
  c: Pick<PoolClient, 'query'>,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  return (await isDemoCopy(c)) || (await pocPhaseAt(c, now)).phase !== 'ended';
}

/** Where the POC stands at `now`: none, scheduled (switched on, not started), running or ended. */
export async function pocPhaseAt(c: Pick<PoolClient, 'query'>, now: number): Promise<PocPhase> {
  return pocPhase(await businessModes(c), await pocMonthsSetting(c), now);
}

/** Every switch with who made it, why and when (oldest first), for the staff portal. */
export async function businessModeHistory(c: Pick<PoolClient, 'query'>): Promise<
  {
    readonly mode: BusinessMode;
    readonly from: number;
    readonly setBy: string;
    readonly reason: string;
    readonly setAt: number;
  }[]
> {
  const r = await c.query<{
    mode: BusinessMode;
    from: string;
    set_by: string;
    reason: string;
    set_at: string;
  }>(
    `SELECT mode, extract(epoch FROM from_at)::bigint AS from, set_by, reason,
            extract(epoch FROM set_at)::bigint AS set_at
       FROM business_modes ORDER BY from_at`,
  );
  return r.rows.map((x) => ({
    mode: x.mode,
    from: Number(x.from),
    setBy: x.set_by,
    reason: x.reason,
    setAt: Number(x.set_at),
  }));
}

/** Every switch, oldest first. */
export async function businessModes(c: Pick<PoolClient, 'query'>): Promise<ModeChange[]> {
  const r = await c.query<{ mode: BusinessMode; from: string }>(
    'SELECT mode, extract(epoch FROM from_at)::bigint AS from FROM business_modes ORDER BY from_at',
  );
  return r.rows.map((x) => ({ mode: x.mode, from: Number(x.from) }));
}

/** A switch back that would end the POC before its planned end, sent without `early` (P7.8). */
export class EarlyEnd extends Error {
  constructor(readonly days: number) {
    super(`This ends the POC ${days} day${days === 1 ? '' : 's'} early: confirm to go ahead`);
  }
}

/**
 * A super admin flips the business to POC or regular business; returns from when it counts. The
 * POC is switched on from the 1st of a month (today if it is the 1st, else the next 1st), so its
 * months are full months; it is switched off from the start of that business day. The POC runs
 * once: switched on, then off, and never again (the portal hides the switch after that).
 */
export async function setBusinessMode(
  pool: Pool,
  mode: BusinessMode,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
  /** P7.8: the super admin confirmed ending the POC before its planned end. */
  opts: { readonly early?: boolean } = {},
): Promise<number> {
  if (by.role !== 'super-admin') throw new Error('Only a super admin can switch the business');
  if (mode !== 'poc' && mode !== 'regular') throw new RangeError('Mode must be poc or regular');
  return inTransaction(pool, async (c) => {
    // The pay runs take the same lock, so a switch never lands in the middle of one.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('rider-pay'))");
    const changes = await businessModes(c);
    // Switching the POC on counts from the 1st of a month; switching it off, from that day.
    const from = mode === 'poc' ? pocStartsFrom(now) : switchCountsFrom(now);
    const last = changes[changes.length - 1];
    if (last && last.from >= from)
      throw new Error(
        `A switch is already set for ${new Date(last.from * 1000).toISOString().slice(0, 10)}`,
      );
    if (modeAt(changes, from) === mode) throw new Error(`The business is already on ${mode}`);
    // The POC happens once (Prateek, 24 Oct 2026): once it has ended, only regular business is left
    // (in a demo copy for investors, it can be flipped freely).
    const phase = pocPhase(changes, await pocMonthsSetting(c), now);
    // P7.8 (Prateek, 28 Oct 2026): the POC ends by hand, on the morning of the 1st after its months;
    // a switch counting from before that (its 00:00–02:00 tail counts from the day before) needs
    // `early`.
    const early = mode === 'regular' ? pocDaysEarly(phase, from) : 0;
    if (early > 0 && !opts.early) throw new EarlyEnd(early);
    if (pocEndedAt(changes) !== undefined && !(await isDemoCopy(c)))
      throw new Error('The POC has ended: the business stays on regular business');
    await c.query(
      'INSERT INTO business_modes (from_at, mode, set_by, reason) VALUES (to_timestamp($1), $2, $3, $4)',
      [from, mode, by.id, reason],
    );
    return from;
  });
}
