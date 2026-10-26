// P3.3 in the database: the fleet map. Every screen with where it stands now (the Today rules), its
// last position (only ever from the screen itself), the bike and rider it is on and its open alerts;
// and for one screen its route, health, fittings and commands. Nothing here writes.
import {
  DEFAULT_TODAY_RULES,
  fleetState,
  type AlertKind,
  type FleetState,
  type TodayRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { commandLog, pendingCommands, type CommandLogLine } from './commands.js';

type Q = Pick<Pool, 'query'>;

export interface Position {
  readonly t: number;
  readonly lat: number;
  readonly lng: number;
  readonly moving: boolean;
  /** Where the screen said it was: "inside:<area>@<version>", "edge:…" or "outside". */
  readonly place: string;
}

export interface FleetScreen {
  readonly screenId: string;
  readonly bike: string | null;
  readonly riderId: string | null;
  readonly state: FleetState;
  /** The last position the screen sent (within `positionHours`), or null. */
  readonly position: Position | null;
  readonly lastHeard: number | null;
  /** The player version it last said hello with. */
  readonly app: string | null;
  readonly alerts: readonly AlertKind[];
}

/** How far back a last position is still shown on the map (hours). */
export const POSITION_HOURS = 24;

interface Row {
  screen_id: string;
  bike: string | null;
  rider_id: string | null;
  heard: string | null;
  app: string | null;
  live_t: string | null;
  live: { lat: number; lng: number; moving: boolean; place?: string } | null;
  alerts: AlertKind[] | null;
}

/** Every enrolled screen for the map, by bike (screens at the hub last). */
export async function fleetScreens(
  pool: Q,
  now: number,
  rules: TodayRules = DEFAULT_TODAY_RULES,
  /** Only this screen. */
  only?: string,
): Promise<FleetScreen[]> {
  const r = await pool.query<Row>(
    `SELECT s.screen_id, f.bike, f.rider_id,
            extract(epoch FROM greatest(
              (SELECT max(received_at) FROM screen_reports r WHERE r.screen_id = s.screen_id),
              (SELECT max(at) FROM screen_hellos h WHERE h.screen_id = s.screen_id)))::bigint AS heard,
            (SELECT app FROM screen_hellos h WHERE h.screen_id = s.screen_id ORDER BY at DESC LIMIT 1) AS app,
            extract(epoch FROM l.made_at)::bigint AS live_t, l.body AS live,
            (SELECT array_agg(kind ORDER BY kind) FROM (
               SELECT DISTINCT ON (kind) kind, state FROM screen_alert_events a
                WHERE a.screen_id = s.screen_id ORDER BY kind, id DESC) x
              WHERE state = 'raised') AS alerts
       FROM screens s
       LEFT JOIN LATERAL (SELECT bike, rider_id FROM screen_fittings WHERE screen_id = s.screen_id
                            AND from_at <= to_timestamp($1) ORDER BY from_at DESC LIMIT 1) f ON true
       LEFT JOIN LATERAL (SELECT made_at, body FROM screen_reports WHERE screen_id = s.screen_id
                            AND kind = 'live' AND made_at <= to_timestamp($1)
                            AND made_at > to_timestamp($1) - make_interval(hours => $2)
                          ORDER BY made_at DESC LIMIT 1) l ON true
      WHERE $3::text IS NULL OR s.screen_id = $3
      ORDER BY f.bike IS NULL, f.bike, s.screen_id`,
    [now, POSITION_HOURS, only ?? null],
  );
  return r.rows.map((x) => {
    const position: Position | null =
      x.live && x.live_t !== null
        ? {
            t: Number(x.live_t),
            lat: x.live.lat,
            lng: x.live.lng,
            moving: x.live.moving === true,
            place: x.live.place ?? 'outside',
          }
        : null;
    const lastHeard = x.heard === null ? null : Number(x.heard);
    return {
      screenId: x.screen_id,
      bike: x.bike,
      riderId: x.rider_id,
      state: fleetState({ fitted: x.bike !== null, lastHeard, lastLive: position }, now, rules),
      position,
      lastHeard,
      app: x.app,
      alerts: x.alerts ?? [],
    };
  });
}

export interface HealthNow {
  readonly t: number;
  readonly app: string;
  readonly batteryPct: number | null;
  readonly charging: boolean | null;
  readonly batteryC: number | null;
  readonly boxC: number | null;
  readonly freeMb: number;
  readonly signalDbm: number | null;
  readonly ledFault: boolean | null;
  readonly tamper: boolean | null;
}

export interface ScreenDetail {
  readonly screen: FleetScreen;
  /** Positions in the last `routeHours`, oldest first (at most 2,000). */
  readonly route: readonly Position[];
  readonly health: HealthNow | null;
  /** Bikes it was fitted to, newest first (null bike: taken off). */
  readonly fittings: readonly {
    from: number;
    bike: string | null;
    riderId: string | null;
    reason: string;
  }[];
  readonly commands: readonly CommandLogLine[];
}

/** One screen for its panel on the map, or undefined when no such screen. */
export async function screenDetail(
  pool: Q,
  screenId: string,
  now: number,
  routeHours = 2,
): Promise<ScreenDetail | undefined> {
  const [screen] = await fleetScreens(pool, now, DEFAULT_TODAY_RULES, screenId);
  if (!screen) return undefined;
  const route = await pool.query<{ t: string; body: Position & { kind: string } }>(
    `SELECT extract(epoch FROM made_at)::bigint AS t, body FROM screen_reports
      WHERE screen_id = $1 AND kind = 'live' AND made_at <= to_timestamp($2)
        AND made_at > to_timestamp($2) - make_interval(secs => $3)
      ORDER BY made_at DESC LIMIT 2000`,
    [screenId, now, Math.round(routeHours * 3600)],
  );
  const h = await pool.query<{
    t: string;
    app: string;
    battery_pct: number | null;
    charging: boolean | null;
    battery_c: number | null;
    box_c: number | null;
    free_mb: number;
    signal_dbm: number | null;
    led_fault: boolean | null;
    tamper: boolean | null;
  }>(
    `SELECT extract(epoch FROM t)::bigint AS t, app, battery_pct, charging, battery_c, box_c, free_mb,
            signal_dbm, led_fault, tamper
       FROM screen_health WHERE screen_id = $1 AND t <= to_timestamp($2)
      ORDER BY t DESC, seq DESC LIMIT 1`,
    [screenId, now],
  );
  const f = await pool.query<{
    from_s: string;
    bike: string | null;
    rider_id: string | null;
    reason: string;
  }>(
    `SELECT extract(epoch FROM from_at)::bigint AS from_s, bike, rider_id, reason FROM screen_fittings
      WHERE screen_id = $1 ORDER BY from_at DESC LIMIT 20`,
    [screenId],
  );
  const x = h.rows[0];
  return {
    screen,
    route: route.rows
      .map((p) => ({
        t: Number(p.t),
        lat: p.body.lat,
        lng: p.body.lng,
        moving: p.body.moving === true,
        place: p.body.place ?? 'outside',
      }))
      .reverse(),
    health: x
      ? {
          t: Number(x.t),
          app: x.app,
          batteryPct: x.battery_pct,
          charging: x.charging,
          batteryC: x.battery_c,
          boxC: x.box_c,
          freeMb: x.free_mb,
          signalDbm: x.signal_dbm,
          ledFault: x.led_fault,
          tamper: x.tamper,
        }
      : null,
    fittings: f.rows.map((r) => ({
      from: Number(r.from_s),
      bike: r.bike,
      riderId: r.rider_id,
      reason: r.reason,
    })),
    commands: await commandLog(pool, screenId, now * 1000, 20),
  };
}

/**
 * Commands issued in the last `windowMs` and not yet answered, with their ids, as messages per
 * screen: the gateway sends each once at once (remembering the ids it sent), so a screen whose line
 * is open gets it within seconds instead of at its next hello. The window is wide (a minute) so a
 * command whose request took a while to commit, or made on a clock a little behind, is not missed.
 */
export async function freshCommands(
  pool: Q,
  nowMs: number,
  windowMs = 60_000,
): Promise<{ screenId: string; id: string; text: string }[]> {
  const r = await pool.query<{ screen_id: string }>(
    `SELECT DISTINCT screen_id FROM screen_commands
      WHERE made_at > to_timestamp($1 / 1000.0) ORDER BY screen_id`,
    [nowMs - windowMs],
  );
  const out: { screenId: string; id: string; text: string }[] = [];
  for (const s of r.rows)
    for (const text of await pendingCommands(pool, s.screen_id, nowMs)) {
      const id = (JSON.parse(text) as { id: string }).id;
      out.push({ screenId: s.screen_id, id, text });
    }
  return out;
}
