// P1.7.5 (Prateek, 28 Oct 2026): where a rider's moving hours count depends on the business mode in
// force at that second: the POC's circle (pocZone) or, in regular business, inside the areas that
// are on (regularZone). Each zone is a versioned setting; a minute is judged by the version in
// force then, so saving a zone never changes hours already worked.
import {
  DEFAULT_SETTINGS,
  modeAt,
  zoneForMode,
  type ModeChange,
  type PayZone,
} from '@recall/domain';
import type { PoolClient } from 'pg';
import { businessModes } from './business-mode.js';

type Q = Pick<PoolClient, 'query'>;

interface Version {
  readonly from: number;
  readonly value: PayZone;
}

/** The versions of one zone setting, oldest first; the copy made by the P1.7.5 migration was in
 * force from the start (it carries the zone saved before the split). */
async function versions(c: Q, key: 'pocZone' | 'regularZone'): Promise<Version[]> {
  const r = await c.query<{ value: PayZone; at: string; saved_by: string }>(
    `SELECT value, extract(epoch FROM saved_at)::bigint AS at, saved_by FROM settings
      WHERE key = $1 ORDER BY version`,
    [key],
  );
  return r.rows.map((x, i) => ({
    from: i === 0 && x.saved_by === 'migration' ? -Infinity : Number(x.at),
    value: x.value,
  }));
}

function at(vs: readonly Version[], fallback: PayZone, t: number): PayZone {
  let z = fallback;
  for (const v of vs) if (v.from <= t) z = v.value;
  return z;
}

/** The pay zone in force at each moment: the zone of the business mode then, as saved then. */
export async function payZoneAt(
  c: Q,
  changes?: readonly ModeChange[],
): Promise<(t: number) => PayZone> {
  const [modes, poc, regular] = await Promise.all([
    changes ? Promise.resolve(changes) : businessModes(c),
    versions(c, 'pocZone'),
    versions(c, 'regularZone'),
  ]);
  return (t) =>
    zoneForMode(modeAt(modes, t), {
      pocZone: at(poc, DEFAULT_SETTINGS.pocZone, t),
      regularZone: at(regular, DEFAULT_SETTINGS.regularZone, t),
    });
}
