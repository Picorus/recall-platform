// P2.11 in the database: each screen's health reports, and alerts raised and cleared on them (and on
// a screen not heard from for 30 minutes). An alert's life is its events, never a changed row.
import {
  DEFAULT_HEALTH_RULES,
  HEALTH_ALERT_KINDS,
  healthAlerts,
  type AlertKind,
  type HealthReport,
  type HealthRules,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

/** The alerts open now for a screen (the latest event of each kind is "raised"). */
async function openKinds(c: Q, screenId: string): Promise<Set<AlertKind>> {
  const r = await c.query<{ kind: AlertKind }>(
    `SELECT kind FROM (
       SELECT DISTINCT ON (kind) kind, state FROM screen_alert_events
        WHERE screen_id = $1 ORDER BY kind, id DESC) latest
      WHERE state = 'raised'`,
    [screenId],
  );
  return new Set(r.rows.map((x) => x.kind));
}

async function event(
  c: Q,
  screenId: string,
  kind: AlertKind,
  state: 'raised' | 'cleared',
  at: number,
) {
  await c.query(
    `INSERT INTO screen_alert_events (screen_id, kind, state, at) VALUES ($1, $2, $3, to_timestamp($4))`,
    [screenId, kind, state, at],
  );
}

/**
 * Stores one health report (inside an upload's transaction) and raises or clears the alerts it
 * decides. A report older than the newest one already stored is kept but changes no alert: reports
 * can arrive out of order after a box was offline.
 */
export async function storeHealth(
  c: Q,
  screenId: string,
  seq: number,
  h: HealthReport,
  rules: HealthRules = DEFAULT_HEALTH_RULES,
): Promise<void> {
  const newest = await c.query<{ t: string | null }>(
    'SELECT extract(epoch FROM max(t))::bigint AS t FROM screen_health WHERE screen_id = $1',
    [screenId],
  );
  const latestT = newest.rows[0]?.t;
  await c.query(
    `INSERT INTO screen_health (screen_id, t, seq, app, up_s, battery_pct, charging, battery_c, box_c,
       free_mb, signal_dbm, led_fault, tamper, clock_disagree, spots_not_counted, plays_not_stored,
       messages_refused, gps_missed_seconds, ads_missing, app_code, crashes)
     VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      screenId,
      h.t,
      seq,
      h.app,
      h.upS,
      h.batteryPct,
      h.charging,
      h.batteryC,
      h.boxC,
      h.freeMb,
      h.signalDbm,
      h.ledFault,
      h.tamper,
      h.clockDisagree,
      h.spotsNotCounted,
      h.playsNotStored,
      h.messagesRefused,
      h.gpsMissedSeconds,
      h.adsMissing,
      h.appCode ?? null,
      h.crashes ?? null,
    ],
  );
  if (latestT !== null && latestT !== undefined && h.t < Number(latestT)) return;
  const want = healthAlerts(h, rules);
  const open = await openKinds(c, screenId);
  for (const kind of HEALTH_ALERT_KINDS) {
    if (want.has(kind) && !open.has(kind)) await event(c, screenId, kind, 'raised', h.t);
    if (!want.has(kind) && open.has(kind)) await event(c, screenId, kind, 'cleared', h.t);
  }
}

/** The screen was heard from (an upload or a hello): a "no contact" alert clears. */
export async function heardFrom(c: Q, screenId: string, atSeconds: number): Promise<void> {
  if ((await openKinds(c, screenId)).has('no-contact'))
    await event(c, screenId, 'no-contact', 'cleared', atSeconds);
}

/**
 * Raises "no contact" for every screen not heard from (no upload, no hello) for `silentMinutes`.
 * Run every minute or so (a worker). Returns the screens newly raised.
 */
export async function raiseSilentAlerts(
  pool: Pool,
  nowMs: number,
  rules: HealthRules = DEFAULT_HEALTH_RULES,
): Promise<string[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    const r = await c.query<{ screen_id: string }>(
      `WITH heard AS (
         SELECT i.screen_id,
                greatest((SELECT max(received_at) FROM screen_reports r WHERE r.screen_id = i.screen_id),
                         (SELECT max(at) FROM screen_hellos h WHERE h.screen_id = i.screen_id)) AS last
           FROM screen_inboxes i),
       open AS (
         SELECT DISTINCT ON (screen_id) screen_id, state FROM screen_alert_events
          WHERE kind = 'no-contact' ORDER BY screen_id, id DESC)
       SELECT heard.screen_id FROM heard LEFT JOIN open USING (screen_id)
        WHERE heard.last IS NOT NULL
          AND heard.last <= to_timestamp($1 / 1000.0) - make_interval(mins => $2)
          AND (open.state IS NULL OR open.state = 'cleared')
        ORDER BY heard.screen_id`,
      [nowMs, rules.silentMinutes],
    );
    for (const row of r.rows)
      await event(c, row.screen_id, 'no-contact', 'raised', Math.floor(nowMs / 1000));
    await c.query('COMMIT');
    return r.rows.map((x) => x.screen_id);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Alerts open now, all screens or one, oldest first: for the health view (P3). */
export async function openAlerts(
  pool: Pick<Pool, 'query'>,
  screenId?: string,
): Promise<{ readonly screenId: string; readonly kind: AlertKind; readonly since: number }[]> {
  const r = await pool.query<{ screen_id: string; kind: AlertKind; since: string }>(
    `SELECT screen_id, kind, extract(epoch FROM at)::bigint AS since FROM (
       SELECT DISTINCT ON (screen_id, kind) screen_id, kind, state, at FROM screen_alert_events
        WHERE $1::text IS NULL OR screen_id = $1
        ORDER BY screen_id, kind, id DESC) latest
      WHERE state = 'raised' ORDER BY since, screen_id, kind`,
    [screenId ?? null],
  );
  return r.rows.map((x) => ({ screenId: x.screen_id, kind: x.kind, since: Number(x.since) }));
}
