// P3.2 in the database: the numbers for the admin Today page, read from the stored records (screen
// reports and hellos, fittings, sold booking lines and their counted plays, make-ups, refunds, open
// alerts). Nothing here writes. Each part is read only when the page may show it.
import {
  DEFAULT_TODAY_RULES,
  fleetState,
  hoursToday,
  lineIdOf,
  todayOf,
  weekStartOf,
  type AlertKind,
  type FleetState,
  type HoursToday,
  type SoldLine,
  type TodayRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { openAlerts } from './health.js';
import { lineTotalsFor } from './plays.js';
import { priceBooks } from './bookings.js';

type Q = Pick<Pool, 'query'>;

export interface FleetNow {
  readonly moving: number;
  readonly stopped: number;
  readonly offline: number;
  readonly atHub: number;
  readonly total: number;
}

/** Every enrolled screen, by where it stands now (seconds). */
export async function fleetNow(
  pool: Q,
  now: number,
  rules: TodayRules = DEFAULT_TODAY_RULES,
): Promise<FleetNow> {
  const r = await pool.query<{
    fitted: boolean;
    heard: string | null;
    live_t: string | null;
    moving: boolean | null;
  }>(
    `SELECT coalesce(f.bike IS NOT NULL, false) AS fitted,
            extract(epoch FROM greatest(
              (SELECT max(received_at) FROM screen_reports r WHERE r.screen_id = s.screen_id),
              (SELECT max(at) FROM screen_hellos h WHERE h.screen_id = s.screen_id)))::bigint AS heard,
            extract(epoch FROM l.made_at)::bigint AS live_t,
            (l.body->>'moving')::boolean AS moving
       FROM screens s
       LEFT JOIN LATERAL (SELECT bike FROM screen_fittings WHERE screen_id = s.screen_id
                            AND from_at <= to_timestamp($1) ORDER BY from_at DESC LIMIT 1) f ON true
       LEFT JOIN LATERAL (SELECT made_at, body FROM screen_reports WHERE screen_id = s.screen_id
                            AND kind = 'live' AND made_at <= to_timestamp($1)
                            AND made_at > to_timestamp($1) - make_interval(mins => $2)
                          ORDER BY made_at DESC LIMIT 1) l ON true`,
    [now, rules.liveMinutes],
  );
  const n: Record<FleetState, number> = { moving: 0, stopped: 0, offline: 0, 'at-hub': 0 };
  for (const x of r.rows) {
    const state = fleetState(
      {
        fitted: x.fitted,
        lastHeard: x.heard === null ? null : Number(x.heard),
        lastLive: x.live_t === null ? null : { t: Number(x.live_t), moving: x.moving === true },
      },
      now,
      rules,
    );
    n[state]++;
  }
  return {
    moving: n.moving,
    stopped: n.stopped,
    offline: n.offline,
    atHub: n['at-hub'],
    total: r.rows.length,
  };
}

/**
 * Bike-hours sold for the business day (bookings paid and not cancelled, trials included: they run
 * on real bikes) and what was delivered in the hours already over.
 */
export async function hoursSoldToday(pool: Q, now: number): Promise<{ day: string } & HoursToday> {
  const day = todayOf(now);
  const r = await pool.query<{
    booking_id: string;
    area_id: string;
    day: string;
    start_hour: number;
    bikes: number;
    plays: number;
  }>(
    `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.bikes, bl.plays
       FROM booking_lines bl
      WHERE bl.day = $1::date
        AND EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = bl.booking_id AND e.state = 'paid')
        AND (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
              ORDER BY seq DESC LIMIT 1) <> 'cancelled'
      ORDER BY bl.start_hour, bl.booking_id, bl.area_id`,
    [day],
  );
  const books = r.rows.length > 0 ? await priceBooks(pool) : [];
  const lines: SoldLine[] = [];
  for (const l of r.rows) {
    const lineId = lineIdOf(l.booking_id, l.area_id, l.day, l.start_hour);
    const counted = (await lineTotalsFor(pool, lineId, books)).plays;
    lines.push({ date: l.day, startHour: l.start_hour, bikes: l.bikes, plays: l.plays, counted });
  }
  return { day, ...hoursToday(lines, now) };
}

export interface MakeUpOwed {
  readonly makeUpId: string;
  readonly brandId: string;
  readonly areaId: string;
  readonly from: number;
  readonly until: number;
  readonly plays: number;
  readonly left: number;
}

/** Make-ups whose window has not ended and that still owe plays, soonest first. */
export async function makeUpsOwed(pool: Q, now: number): Promise<MakeUpOwed[]> {
  const r = await pool.query<{
    make_up_id: string;
    brand_id: string;
    area_id: string;
    from_s: string;
    until_s: string;
    plays: number;
  }>(
    `SELECT m.make_up_id, b.brand_id, m.area_id, extract(epoch FROM m.window_from)::bigint AS from_s,
            extract(epoch FROM m.window_until)::bigint AS until_s, m.plays
       FROM make_ups m JOIN bookings b USING (booking_id)
      WHERE m.window_until > to_timestamp($1)
      ORDER BY m.window_from, m.make_up_id`,
    [now],
  );
  const books = r.rows.length > 0 ? await priceBooks(pool) : [];
  const out: MakeUpOwed[] = [];
  for (const m of r.rows) {
    const left = m.plays - (await lineTotalsFor(pool, m.make_up_id, books)).plays;
    if (left > 0)
      out.push({
        makeUpId: m.make_up_id,
        brandId: m.brand_id,
        areaId: m.area_id,
        from: Number(m.from_s),
        until: Number(m.until_s),
        plays: m.plays,
        left,
      });
  }
  return out;
}

export interface RefundsThisWeek {
  /** Monday 00:00 India time (UTC seconds). */
  readonly since: number;
  readonly proposed: number;
  /** Waiting for a super admin's decision, and their amount with GST (paise). */
  readonly waiting: number;
  readonly waitingPaise: number;
  readonly approved: number;
  /** Approved amount with GST, top-ups included (paise). */
  readonly approvedPaise: number;
  readonly rejected: number;
}

/** Refunds proposed this week (Monday to now, India time), by what was decided. */
export async function refundsThisWeek(pool: Q, now: number): Promise<RefundsThisWeek> {
  const since = weekStartOf(now);
  const r = await pool.query<{ decision: string | null; n: string; paise: string }>(
    `SELECT d.decision, count(*) AS n,
            coalesce(sum(f.base_paise + f.gst_paise + coalesce(t.base_paise + t.gst_paise, 0)), 0) AS paise
       FROM refunds f
       LEFT JOIN refund_decisions d USING (refund_id)
       LEFT JOIN refund_topups t USING (refund_id)
      WHERE f.proposed_at >= to_timestamp($1) AND f.proposed_at <= to_timestamp($2)
      GROUP BY d.decision`,
    [since, now],
  );
  const of = (d: string | null) => r.rows.find((x) => x.decision === d);
  const n = (d: string | null) => Number(of(d)?.n ?? 0);
  const paise = (d: string | null) => Number(of(d)?.paise ?? 0);
  return {
    since,
    proposed: n(null) + n('approved') + n('rejected'),
    waiting: n(null),
    // A waiting refund has no top-up yet: its amount is what was proposed.
    waitingPaise: paise(null),
    approved: n('approved'),
    approvedPaise: paise('approved'),
    rejected: n('rejected'),
  };
}

export interface AlertNow {
  readonly screenId: string;
  readonly bike: string | null;
  readonly kind: AlertKind;
  readonly since: number;
}

/** Open alerts, oldest first, with the bike each screen is on now (at most `limit`). */
export async function alertsNow(
  pool: Q,
  now: number,
  limit = 50,
): Promise<{ readonly total: number; readonly list: AlertNow[] }> {
  const all = await openAlerts(pool);
  const list: AlertNow[] = [];
  for (const a of all.slice(0, limit)) {
    const f = await pool.query<{ bike: string | null }>(
      `SELECT bike FROM screen_fittings WHERE screen_id = $1 AND from_at <= to_timestamp($2)
        ORDER BY from_at DESC LIMIT 1`,
      [a.screenId, now],
    );
    list.push({ ...a, bike: f.rows[0]?.bike ?? null });
  }
  return { total: all.length, list };
}
