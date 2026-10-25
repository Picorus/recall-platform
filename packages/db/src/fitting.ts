// P2.14 in the database: fitting reports with the cloud's own verdict; the latest says whether the
// bike is ready.
import { fittingVerdict, type FittingReport, type FittingVerdict } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/** Stores a fitting report (inside an upload's transaction) with the cloud's verdict. */
export async function storeFitting(c: Q, screenId: string, seq: number, r: FittingReport) {
  const v = fittingVerdict(r);
  await c.query(
    `INSERT INTO fitting_checks (screen_id, seq, command_id, at, gps_accuracy_m, line_up, camera,
       battery_pct, charging, panel, verdict, ready)
     VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      screenId,
      seq,
      r.id,
      r.at,
      r.gpsAccuracyM,
      r.lineUp,
      r.camera,
      r.batteryPct,
      r.charging,
      r.panel,
      JSON.stringify(v),
      v.ready,
    ],
  );
}

/** The latest fitting check of a screen, or undefined when it was never checked. */
export async function latestFitting(
  pool: Pick<Pool, 'query'>,
  screenId: string,
): Promise<{ readonly at: number; readonly verdict: FittingVerdict } | undefined> {
  const r = await pool.query<{ at: string; verdict: FittingVerdict }>(
    `SELECT extract(epoch FROM at)::bigint AS at, verdict FROM fitting_checks
      WHERE screen_id = $1 ORDER BY at DESC, seq DESC LIMIT 1`,
    [screenId],
  );
  const x = r.rows[0];
  return x ? { at: Number(x.at), verdict: x.verdict } : undefined;
}
