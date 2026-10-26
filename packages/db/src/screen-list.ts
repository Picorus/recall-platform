// P3.4 in the database: the Screens page. Every enrolled screen with where it is in its life (on a
// bike, in stock, in repair, retired), the bike and rider, where it stands now (the Today rules),
// its player version, latest health, last fitting check and certificate. Nothing here writes.
import {
  DEFAULT_STOCK_RULES,
  DEFAULT_TODAY_RULES,
  fleetState,
  type FleetState,
  type FittingVerdict,
  type StockRules,
  type TodayRules,
} from '@recall/domain';
import type { Pool } from 'pg';

export type ScreenLife = 'on-bike' | 'in-stock' | 'in-repair' | 'retired';

export interface ScreenRow {
  readonly screenId: string;
  readonly serial: string;
  readonly model: string;
  readonly enrolledAt: number;
  readonly life: ScreenLife;
  /** Why it is in repair or retired (the newest service step), or null. */
  readonly serviceNote: string | null;
  readonly bike: string | null;
  readonly riderId: string | null;
  readonly state: FleetState;
  readonly lastHeard: number | null;
  readonly app: string | null;
  readonly batteryPct: number | null;
  readonly boxC: number | null;
  readonly alerts: number;
  /** The last fitting check: when, and whether every part passed. */
  readonly fittingCheck: { readonly at: number; readonly ready: boolean } | null;
  readonly certificateUntil: number | null;
  /** It could be fitted now: a valid certificate and its play key not given up (lost or stolen). */
  readonly fittable: boolean;
}

/** Every enrolled screen for the Screens page, bikes first. Times in seconds. */
export async function screenList(
  pool: Pick<Pool, 'query'>,
  now: number,
  rules: TodayRules = DEFAULT_TODAY_RULES,
): Promise<ScreenRow[]> {
  const r = await pool.query<{
    screen_id: string;
    hardware_serial: string;
    model: string;
    enrolled: string;
    service: 'to-repair' | 'repaired' | 'retired' | null;
    service_reason: string | null;
    bike: string | null;
    rider_id: string | null;
    heard: string | null;
    live_t: string | null;
    moving: boolean | null;
    app: string | null;
    battery_pct: number | null;
    box_c: number | null;
    alerts: string;
    check_at: string | null;
    verdict: FittingVerdict | null;
    cert_until: string | null;
    key_ok: boolean;
  }>(
    `SELECT s.screen_id, s.hardware_serial, s.model, extract(epoch FROM s.enrolled_at)::bigint AS enrolled,
            v.kind AS service, v.reason AS service_reason, f.bike, f.rider_id,
            extract(epoch FROM greatest(
              (SELECT max(received_at) FROM screen_reports r WHERE r.screen_id = s.screen_id),
              (SELECT max(at) FROM screen_hellos h WHERE h.screen_id = s.screen_id)))::bigint AS heard,
            extract(epoch FROM l.made_at)::bigint AS live_t, (l.body->>'moving')::boolean AS moving,
            (SELECT app FROM screen_hellos h WHERE h.screen_id = s.screen_id ORDER BY at DESC LIMIT 1) AS app,
            hl.battery_pct, hl.box_c,
            (SELECT count(*) FROM (
               SELECT DISTINCT ON (kind) state FROM screen_alert_events a
                WHERE a.screen_id = s.screen_id ORDER BY kind, id DESC) x WHERE state = 'raised') AS alerts,
            extract(epoch FROM fc.at)::bigint AS check_at, fc.verdict,
            (SELECT extract(epoch FROM max(not_after))::bigint FROM screen_certificates c
              WHERE c.screen_id = s.screen_id) AS cert_until,
            EXISTS (SELECT 1 FROM screen_keys k LEFT JOIN screen_key_revocations rv USING (screen_id, key_id)
                     WHERE k.screen_id = s.screen_id AND rv.key_id IS NULL) AS key_ok
       FROM screens s
       LEFT JOIN LATERAL (SELECT kind, reason FROM screen_service_events WHERE screen_id = s.screen_id
                            AND at <= to_timestamp($1) ORDER BY id DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT bike, rider_id FROM screen_fittings WHERE screen_id = s.screen_id
                            AND from_at <= to_timestamp($1) ORDER BY from_at DESC LIMIT 1) f ON true
       LEFT JOIN LATERAL (SELECT made_at, body FROM screen_reports WHERE screen_id = s.screen_id
                            AND kind = 'live' AND made_at <= to_timestamp($1)
                            AND made_at > to_timestamp($1) - make_interval(mins => $2)
                          ORDER BY made_at DESC LIMIT 1) l ON true
       LEFT JOIN LATERAL (SELECT battery_pct, box_c FROM screen_health WHERE screen_id = s.screen_id
                          ORDER BY t DESC, seq DESC LIMIT 1) hl ON true
       LEFT JOIN LATERAL (SELECT at, verdict FROM fitting_checks WHERE screen_id = s.screen_id
                          ORDER BY at DESC, seq DESC LIMIT 1) fc ON true
      ORDER BY f.bike IS NULL, f.bike, s.screen_id`,
    [now, rules.liveMinutes],
  );
  return r.rows.map((x) => {
    const lastHeard = x.heard === null ? null : Number(x.heard);
    const life: ScreenLife = x.bike
      ? 'on-bike'
      : x.service === 'to-repair'
        ? 'in-repair'
        : x.service === 'retired'
          ? 'retired'
          : 'in-stock';
    return {
      screenId: x.screen_id,
      serial: x.hardware_serial,
      model: x.model,
      enrolledAt: Number(x.enrolled),
      life,
      serviceNote: life === 'in-repair' || life === 'retired' ? x.service_reason : null,
      bike: x.bike,
      riderId: x.rider_id,
      state: fleetState(
        {
          fitted: x.bike !== null,
          lastHeard,
          lastLive: x.live_t === null ? null : { t: Number(x.live_t), moving: x.moving === true },
        },
        now,
        rules,
      ),
      lastHeard,
      app: x.app,
      batteryPct: x.battery_pct,
      boxC: x.box_c,
      alerts: Number(x.alerts),
      fittingCheck:
        x.check_at === null || !x.verdict
          ? null
          : { at: Number(x.check_at), ready: x.verdict.ready },
      certificateUntil: x.cert_until === null ? null : Number(x.cert_until),
      fittable: x.key_ok && x.cert_until !== null && Number(x.cert_until) > now,
    };
  });
}

/**
 * Counts for the top of the page, and the spares the fleet should hold (a setting). Spares that
 * cannot be fitted (no valid certificate, or reported lost) are counted apart, not as stock.
 */
export function stockCounts(
  rows: readonly ScreenRow[],
  rules: StockRules = DEFAULT_STOCK_RULES,
): {
  onBike: number;
  inStock: number;
  cannotFit: number;
  inRepair: number;
  retired: number;
  sparesWanted: number;
} {
  const n = (l: ScreenLife) => rows.filter((r) => r.life === l).length;
  const onBike = n('on-bike');
  const cannotFit = rows.filter((r) => r.life === 'in-stock' && !r.fittable).length;
  return {
    onBike,
    inStock: n('in-stock') - cannotFit,
    cannotFit,
    inRepair: n('in-repair'),
    retired: n('retired'),
    sparesWanted: Math.ceil(onBike * rules.spareShare),
  };
}
