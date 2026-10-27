// P4.4 in the database: the rider app's Today page. His screen now (on and playing, bike stopped,
// or off), its battery and signal; his counted moving hours today and this week, from the screens
// he rode while he rode them (as his pay counts them); and what that earned before TDS, by his pay
// rules (packages/domain/src/rider-today.ts). Read only: the pay run stays the one that pays.
import {
  daysBetween,
  dayEarnings,
  dailyTotals,
  DEFAULT_RIDER_PAY_RULES,
  DEFAULT_TODAY_RULES,
  isoAt,
  modeAt,
  pocFirstMonth,
  priceBookAt,
  signalBars,
  todayOf,
  toIndiaTime,
  weekStartOf,
  type FleetState,
  type MinuteSummary,
} from '@recall/domain';
import type { Pool } from 'pg';
import { priceBooks } from './bookings.js';
import { businessModes } from './business-mode.js';
import { fleetScreens } from './fleet.js';
import { minutesOf } from './screen-reports.js';

type Q = Pick<Pool, 'query'>;

/** 08:00 India time on a business day, in UTC seconds. */
const opensAt = (day: string) => Date.parse(`${day}T02:30:00Z`) / 1000;
/** 02:00 India time after it (the business day's end). */
const closesAt = (day: string) => opensAt(day) + 18 * 3600;

export interface RiderTodayDay {
  readonly day: string;
  readonly countedSeconds: number;
  readonly earnedPaise: number;
}

export interface RiderToday {
  readonly at: number;
  /** His screen now, or null when none is on his bike. */
  readonly screen: {
    readonly screenId: string;
    readonly state: FleetState;
    readonly lastHeard: number | null;
    readonly batteryPct: number | null;
    readonly charging: boolean | null;
    readonly signalBars: number | null;
  } | null;
  readonly mode: 'poc' | 'regular';
  readonly today: RiderTodayDay;
  /** Monday to today, each day and the total. */
  readonly week: {
    readonly days: readonly RiderTodayDay[];
    readonly countedSeconds: number;
    readonly earnedPaise: number;
  };
  /** Pay rules in force, for the words the app shows. */
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

/** His stretches on screens (rider pay follows the screen) overlapping [from, to). */
async function stretchesOf(pool: Q, riderId: string, from: number, to: number) {
  const r = await pool.query<{ screen_id: string; a: string; b: string | null }>(
    `SELECT screen_id, extract(epoch FROM from_at)::bigint AS a,
            extract(epoch FROM next_at)::bigint AS b
       FROM (SELECT screen_id, rider_id, from_at,
                    lead(from_at) OVER (PARTITION BY screen_id ORDER BY from_at) AS next_at
               FROM rider_screens
              WHERE screen_id IN (SELECT screen_id FROM rider_screens WHERE rider_id = $1)) s
      WHERE rider_id = $1 AND from_at < to_timestamp($3)
        AND (next_at IS NULL OR next_at > to_timestamp($2))
      ORDER BY from_at`,
    [riderId, from, to],
  );
  return r.rows.map((x) => ({
    screenId: x.screen_id,
    from: Number(x.a),
    to: x.b === null ? Number.POSITIVE_INFINITY : Number(x.b),
  }));
}

export async function riderToday(pool: Q, riderId: string, now: number): Promise<RiderToday> {
  const today = todayOf(now);
  // The week of today's business day (a Monday 01:00 is still Sunday's: that week).
  const monday = toIndiaTime(new Date(weekStartOf(opensAt(today)) * 1000)).date;
  const days = daysBetween(monday, today);
  const from = opensAt(days[0] ?? today);
  const to = Math.min(now, closesAt(today));

  const [books, changes, stretches] = await Promise.all([
    priceBooks(pool),
    businessModes(pool),
    stretchesOf(pool, riderId, from, to),
  ]);
  // The rider pay in force now (the defaults on a laptop with no price book saved yet).
  const rules =
    (priceBookAt(books, isoAt(now)) ?? books.at(-1))?.riderPay ?? DEFAULT_RIDER_PAY_RULES;

  // A minute belongs to whoever rode its screen at its start (as the pay run counts).
  const minutes: MinuteSummary[] = [];
  for (const s of stretches)
    for (const m of await minutesOf(pool, s.screenId, Math.max(from, s.from), Math.min(to, s.to)))
      if (m.minute >= s.from && m.minute < s.to) minutes.push(m);
  const totals = dailyTotals(minutes);
  const pocFirst = pocFirstMonth(changes);
  const perDay = days.map((day) => {
    const countedSeconds = totals.get(day)?.countedSeconds ?? 0;
    const held = stretches.some((s) => s.from < closesAt(day) && s.to > opensAt(day));
    const mode = modeAt(changes, opensAt(day)) === 'poc' ? 'poc' : 'regular';
    return {
      day,
      countedSeconds,
      earnedPaise: dayEarnings(rules, pocFirst, { day, countedSeconds, held, mode }),
    };
  });

  // His screen now: the one on his bike.
  const fitted = await pool.query<{ screen_id: string }>(
    `SELECT screen_id FROM (
       SELECT DISTINCT ON (screen_id) screen_id, rider_id, from_at FROM screen_fittings
        WHERE from_at <= to_timestamp($2) ORDER BY screen_id, from_at DESC) x
      WHERE rider_id = $1 ORDER BY from_at DESC LIMIT 1`,
    [riderId, now],
  );
  const screenId = fitted.rows[0]?.screen_id;
  let screen: RiderToday['screen'] = null;
  if (screenId) {
    const [f] = await fleetScreens(pool, now, DEFAULT_TODAY_RULES, screenId);
    const h = await pool.query<{
      battery_pct: number | null;
      charging: boolean | null;
      signal_dbm: number | null;
    }>(
      `SELECT battery_pct, charging, signal_dbm FROM screen_health
        WHERE screen_id = $1 AND t <= to_timestamp($2) ORDER BY t DESC, seq DESC LIMIT 1`,
      [screenId, now],
    );
    const x = h.rows[0];
    screen = {
      screenId,
      state: f?.state ?? 'offline',
      lastHeard: f?.lastHeard ?? null,
      batteryPct: x?.battery_pct ?? null,
      charging: x?.charging ?? null,
      signalBars: signalBars(x?.signal_dbm ?? null),
    };
  }

  const todayRow = perDay.at(-1) ?? { day: today, countedSeconds: 0, earnedPaise: 0 };
  return {
    at: now,
    screen,
    mode: modeAt(changes, now) === 'poc' ? 'poc' : 'regular',
    today: todayRow,
    week: {
      days: perDay,
      countedSeconds: perDay.reduce((n, d) => n + d.countedSeconds, 0),
      earnedPaise: perDay.reduce((n, d) => n + d.earnedPaise, 0),
    },
    perMovingHourPaise: rules.perMovingHourPaise,
    monthlyCapHours: rules.monthlyCapHours,
  };
}
