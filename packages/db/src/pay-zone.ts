// P1.7.5 (Prateek, 28 Oct 2026): where a rider's moving hours count depends on the business mode in
// force at that second: the POC's circle (pocZone) or, in regular business, inside the areas that
// are on (regularZone). Each zone is a versioned setting; a minute is judged by the version in
// force then, so saving a zone never changes hours already worked. Minutes before the split keep the
// result they had then (review S3).
import {
  DEFAULT_SETTINGS,
  modeAt,
  POC_PAY_ZONE,
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

/** The versions of one zone setting, oldest first, each in force from when it was saved. */
async function versions(c: Q, key: 'pocZone' | 'regularZone' | 'payZone'): Promise<Version[]> {
  const r = await c.query<{ value: PayZone; at: string }>(
    `SELECT value, extract(epoch FROM saved_at)::bigint AS at FROM settings
      WHERE key = $1 ORDER BY version`,
    [key],
  );
  return r.rows.map((x) => ({ from: Number(x.at), value: x.value }));
}

function at(vs: readonly Version[], fallback: PayZone, t: number): PayZone {
  let z = fallback;
  for (const v of vs) if (v.from <= t) z = v.value;
  return z;
}

/** When the zone was split by business mode (migration 0063), UTC seconds. */
async function splitAt(c: Q): Promise<number> {
  const r = await c.query<{ at: string }>(
    'SELECT extract(epoch FROM at)::bigint AS at FROM pay_zone_split LIMIT 1',
  );
  return Number(r.rows[0]?.at ?? 0);
}

/** The pay zone in force at each moment: the zone of the business mode then, as saved then. */
export async function payZoneAt(
  c: Q,
  changes?: readonly ModeChange[],
): Promise<(t: number) => PayZone> {
  const [modes, poc, regular, old, split] = await Promise.all([
    changes ? Promise.resolve(changes) : businessModes(c),
    versions(c, 'pocZone'),
    versions(c, 'regularZone'),
    versions(c, 'payZone'),
    splitAt(c),
  ]);
  return (t) => {
    // Before the split (review S3): as counted then, the seconds the screen marked inside its POC
    // circle in either mode (the old single zone as saved when a circle; the screens never got a
    // list of areas, so they marked the circle then too).
    if (t < split) {
      const z = at(old, POC_PAY_ZONE, t);
      return z.kind === 'circle' ? z : POC_PAY_ZONE;
    }
    return zoneForMode(modeAt(modes, t), {
      pocZone: at(poc, DEFAULT_SETTINGS.pocZone, t),
      regularZone: at(regular, DEFAULT_SETTINGS.regularZone, t),
    });
  };
}
