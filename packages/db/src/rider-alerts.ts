// P4.10 in the database: alerts to riders. Every few minutes the API makes the alerts that are due
// (each once: his payout paid, his screen silent in business hours, its battery low, a repair or a
// swap booked for it), then sends each new one to the phones he is signed in on, in his language;
// never while his bike is moving (it waits until he stops), never one older than a day. The app also
// lists them. Read the rules in packages/domain/src/rider-alerts.ts.
import type { PushAdapter } from '@recall/adapters';
import {
  alertWords,
  businessDayOf,
  DEFAULT_RIDER_SIGN_IN,
  formatRupees,
  mayPush,
  paise,
  RIDER_LANGUAGES,
  todayOf,
  type RiderAlertKind,
  type RiderLanguage,
  type RiderSignInRules,
} from '@recall/domain';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;

const newAlertId = () => `ALR-${randomBytes(6).toString('hex').toUpperCase()}`;

/** The app registers this phone's push token (and his language) for its session. */
export async function registerPush(
  pool: Q,
  tokenHash: string,
  pushToken: string,
  language: string,
  now: number,
): Promise<void> {
  const t = pushToken.trim();
  if (t.length < 10 || t.length > 300 || !/^[\x21-\x7e]+$/.test(t))
    throw new Refusal('Not a push token', { code: 'bad-token' });
  const lang = (RIDER_LANGUAGES as readonly string[]).includes(language) ? language : 'en';
  // The same token and language again changes nothing.
  const last = await pool.query<{ push_token: string; language: string }>(
    'SELECT push_token, language FROM rider_push_tokens WHERE token_hash = $1 ORDER BY id DESC LIMIT 1',
    [tokenHash],
  );
  const l = last.rows[0];
  if (l?.push_token === t && l.language === lang) return;
  await pool.query(
    `INSERT INTO rider_push_tokens (token_hash, push_token, language, at)
     VALUES ($1, $2, $3, to_timestamp($4))`,
    [tokenHash, t, lang, now],
  );
}

const add = (
  c: Q,
  riderId: string,
  kind: RiderAlertKind,
  ref: string,
  vals: Record<string, string | number>,
  now: number,
) =>
  c.query(
    `INSERT INTO rider_alerts (alert_id, rider_id, kind, ref, vals, at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) ON CONFLICT (rider_id, kind, ref) DO NOTHING`,
    [newAlertId(), riderId, kind, ref, JSON.stringify(vals), now],
  );

/** Makes the alerts due at `now` (each once). Returns how many were new. */
export async function makeRiderAlerts(
  pool: Q,
  now: number,
  rules: RiderSignInRules,
): Promise<number> {
  let made = 0;
  const count = (r: { rowCount: number | null }) => {
    made += r.rowCount ?? 0;
  };
  // His payout paid (in the last day).
  const paid = await pool.query<{ run_id: string; rider_id: string; amount: string }>(
    `SELECT a.run_id::text AS run_id, a.rider_id, l.amount_paise AS amount
       FROM payout_attempts a JOIN payout_lines l USING (run_id, rider_id)
      WHERE a.status = 'paid' AND a.at > to_timestamp($1) - interval '1 day'
        AND EXISTS (SELECT 1 FROM riders r WHERE r.rider_id = a.rider_id)`,
    [now],
  );
  for (const p of paid.rows)
    count(
      await add(
        pool,
        p.rider_id,
        'payout-paid',
        `run:${p.run_id}`,
        { amount: formatRupees(paise(Number(p.amount))).replace(/\.00$/, '') },
        now,
      ),
    );

  // Fitted screens of riders on the road: when last heard from, and their latest health.
  const fitted = await pool.query<{
    screen_id: string;
    rider_id: string;
    heard: string | null;
    battery_pct: number | null;
    charging: boolean | null;
    health_t: string | null;
  }>(
    `SELECT f.screen_id, f.rider_id,
            extract(epoch FROM greatest(
              (SELECT max(received_at) FROM screen_reports r WHERE r.screen_id = f.screen_id),
              (SELECT max(at) FROM screen_hellos h WHERE h.screen_id = f.screen_id)))::bigint AS heard,
            h.battery_pct, h.charging, extract(epoch FROM h.t)::bigint AS health_t
       FROM (SELECT DISTINCT ON (screen_id) screen_id, rider_id FROM screen_fittings
              WHERE from_at <= to_timestamp($1) ORDER BY screen_id, from_at DESC) f
       LEFT JOIN LATERAL (SELECT battery_pct, charging, t FROM screen_health x
                           WHERE x.screen_id = f.screen_id ORDER BY t DESC, seq DESC LIMIT 1) h ON true
      WHERE f.rider_id IS NOT NULL
        AND (SELECT status FROM rider_steps s WHERE s.rider_id = f.rider_id
              ORDER BY seq DESC LIMIT 1) = 'active'`,
    [now],
  );
  // Today's business day and when it opened (08:00 India time); none between 02:00 and 08:00.
  const day = businessDayOf(new Date(now * 1000));
  const opened = day === null ? null : Date.parse(`${day}T02:30:00Z`) / 1000;
  for (const f of fitted.rows) {
    const heard = f.heard === null ? null : Number(f.heard);
    // Silent since it was last heard today (one alert a spell): a screen switched off at night
    // is not news at 08:00.
    if (
      opened !== null &&
      heard !== null &&
      heard >= opened &&
      now - heard >= rules.alertOfflineMinutes * 60
    )
      count(
        await add(
          pool,
          f.rider_id,
          'screen-offline',
          `${f.screen_id}:${heard}`,
          { minutes: Math.floor((now - heard) / 60) },
          now,
        ),
      );
    // Battery low, not charging, in the last hour: once a day.
    if (
      f.battery_pct !== null &&
      f.battery_pct <= rules.alertBatteryPct &&
      f.charging !== true &&
      f.health_t !== null &&
      now - Number(f.health_t) <= 3600
    )
      count(
        await add(
          pool,
          f.rider_id,
          'battery-low',
          `${f.screen_id}:${todayOf(now)}`,
          { pct: f.battery_pct },
          now,
        ),
      );
  }

  // A repair or swap booked: a screen sent to repair in the last day, for the rider it was on.
  const repairs = await pool.query<{ id: string; rider_id: string | null }>(
    `SELECT e.id::text AS id,
            (SELECT rider_id FROM screen_fittings f WHERE f.screen_id = e.screen_id
                AND f.from_at < e.at ORDER BY from_at DESC LIMIT 1) AS rider_id
       FROM screen_service_events e
      WHERE e.kind = 'to-repair' AND e.at > to_timestamp($1) - interval '1 day'`,
    [now],
  );
  for (const r of repairs.rows)
    if (r.rider_id) count(await add(pool, r.rider_id, 'repair-booked', `service:${r.id}`, {}, now));
  return made;
}

/** Tries of one alert on one phone before it is given up. */
export const ALERT_TRIES = 3;

/**
 * The phones he can be reached on now: each of his sessions still valid (not ended, used within
 * the idle limit, and his number unchanged since it opened) with its latest push token, when that
 * session is the one that registered the token last (a handset passed on reaches only its new
 * owner) and the token has not been reported gone since.
 */
async function phonesOf(c: Q, riderId: string, now: number, idleDays: number) {
  const r = await c.query<{ push_token: string; language: RiderLanguage }>(
    `WITH mine AS (
       SELECT token_hash FROM rider_sessions WHERE rider_id = $1
       UNION SELECT token_hash FROM rider_session_joins WHERE rider_id = $1),
     valid AS (
       SELECT s.token_hash FROM rider_sessions s JOIN mine USING (token_hash)
        WHERE NOT EXISTS (SELECT 1 FROM rider_session_ends e WHERE e.token_hash = s.token_hash)
          AND s.phone = (SELECT phone FROM rider_versions v WHERE v.rider_id = $1
                          ORDER BY version DESC LIMIT 1)
          AND greatest(s.started_at, (SELECT max(at) FROM rider_session_seen w
                                       WHERE w.token_hash = s.token_hash))
              > to_timestamp($2) - make_interval(days => $3)),
     latest AS (
       SELECT DISTINCT ON (p.token_hash) p.id, p.token_hash, p.push_token, p.language, p.at
         FROM rider_push_tokens p JOIN valid USING (token_hash)
        ORDER BY p.token_hash, p.id DESC)
     SELECT l.push_token, l.language FROM latest l
      WHERE NOT EXISTS (SELECT 1 FROM rider_push_tokens o
                         WHERE o.push_token = l.push_token AND o.id > l.id)
        AND NOT EXISTS (SELECT 1 FROM rider_alert_pushes g
                         WHERE g.push_token = l.push_token AND g.status = 'gone' AND g.at >= l.at)`,
    [riderId, now, idleDays],
  );
  return r.rows;
}

/** Whether the bike carrying the screen he rides now (his current fitting) is moving now. */
async function ridingNow(c: Q, riderId: string, now: number): Promise<boolean> {
  const r = await c.query<{ moving: boolean | null }>(
    `SELECT (SELECT (x.body->>'moving')::boolean FROM screen_reports x
              WHERE x.screen_id = f.screen_id AND x.kind = 'live'
                AND x.made_at > to_timestamp($2) - interval '5 minutes'
              ORDER BY x.made_at DESC LIMIT 1) AS moving
       FROM screen_fittings f
      WHERE f.rider_id = $1 AND f.from_at <= to_timestamp($2)
        AND NOT EXISTS (SELECT 1 FROM screen_fittings g WHERE g.screen_id = f.screen_id
                         AND g.from_at > f.from_at AND g.from_at <= to_timestamp($2))`,
    [riderId, now],
  );
  return r.rows.some((x) => x.moving === true);
}

/**
 * Sends the alerts of the last day not yet sent to each phone he can be reached on, unless his
 * bike is moving now or it is night in India (then later). A phone where one fails 3 times is
 * given up for that alert. One sweep at a time (several API servers never send one twice).
 */
export async function sendRiderAlerts(
  pool: Pool,
  push: PushAdapter,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<{ sent: number; held: number; failed: number }> {
  const out = { sent: 0, held: 0, failed: 0 };
  return inTransaction(pool, async (c) => {
    const got = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('rider-alert-sweep')) AS ok",
    );
    if (!got.rows[0]?.ok) return out;
    const alerts = await c.query<{
      alert_id: string;
      rider_id: string;
      kind: RiderAlertKind;
      vals: Record<string, string | number>;
      at: string;
    }>(
      `SELECT alert_id, rider_id, kind, vals, extract(epoch FROM at)::bigint AS at
         FROM rider_alerts WHERE at > to_timestamp($1) - interval '1 day' ORDER BY at`,
      [now],
    );
    const byRider = new Map<string, typeof alerts.rows>();
    for (const a of alerts.rows) byRider.set(a.rider_id, [...(byRider.get(a.rider_id) ?? []), a]);
    for (const [riderId, his] of byRider) {
      const phones = await phonesOf(c, riderId, now, rules.idleDays);
      if (phones.length === 0) continue;
      const tries = await c.query<{
        alert_id: string;
        push_token: string;
        done: boolean;
        failed: number;
      }>(
        `SELECT alert_id, push_token, bool_or(status IN ('sent', 'gone')) AS done,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM rider_alert_pushes WHERE alert_id = ANY($1) GROUP BY alert_id, push_token`,
        [his.map((a) => a.alert_id)],
      );
      const tried = new Map(tries.rows.map((t) => [`${t.alert_id} ${t.push_token}`, t]));
      const todo = his.flatMap((a) =>
        phones
          .filter((p) => {
            const t = tried.get(`${a.alert_id} ${p.push_token}`);
            return !t?.done && (t?.failed ?? 0) < ALERT_TRIES;
          })
          .map((p) => ({ a, p })),
      );
      if (todo.length === 0) continue;
      const moving = await ridingNow(c, riderId, now);
      for (const { a, p } of todo) {
        if (!mayPush(Number(a.at), now, moving)) {
          out.held += 1;
          continue;
        }
        const w = alertWords(p.language, a.kind, a.vals);
        const hash = createHash('sha256').update(p.push_token).digest('hex').slice(0, 16);
        const r = await push
          .send({ key: `${a.alert_id}:${hash}`, token: p.push_token, title: w.title, body: w.body })
          .catch((e: unknown) => ({ status: 'failed' as const, reason: String(e).slice(0, 200) }));
        if (r.status === 'sent') out.sent += 1;
        else out.failed += 1;
        await c.query(
          `INSERT INTO rider_alert_pushes (alert_id, push_token, status, detail, at)
           VALUES ($1, $2, $3, $4, to_timestamp($5))`,
          [a.alert_id, p.push_token, r.status, r.status === 'failed' ? r.reason : null, now],
        );
      }
    }
    return out;
  });
}

/** His alerts for the app's list, newest first (at most 30). */
export async function riderAlerts(
  c: Q,
  riderId: string,
): Promise<{ kind: RiderAlertKind; vals: Record<string, string | number>; at: number }[]> {
  const r = await c.query<{
    kind: RiderAlertKind;
    vals: Record<string, string | number>;
    at: string;
  }>(
    `SELECT kind, vals, extract(epoch FROM at)::bigint AS at FROM rider_alerts
      WHERE rider_id = $1 ORDER BY at DESC, alert_id LIMIT 30`,
    [riderId],
  );
  return r.rows.map((x) => ({ kind: x.kind, vals: x.vals, at: Number(x.at) }));
}
