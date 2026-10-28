// P4.4 in the database: the rider app's Today page. His screen now (on and playing, bike stopped,
// or off), its battery and signal; his counted moving hours today and this week, from the screens
// he rode while he rode them (as his pay counts them); and what that earned before TDS, by his pay
// rules (packages/domain/src/rider-today.ts). Read only: the pay run stays the one that pays.
// Beside the moving hours, how long his screen was on and reporting ("Screen on": never paid, shown
// so he sees the app is live for more hours than pay counts). P4.5: the same for days he picks.
import {
  daysBetween,
  earningsByDay,
  dailyTotals,
  checkDayRange,
  DEFAULT_RIDER_PAY_RULES,
  DEFAULT_TODAY_RULES,
  isoAt,
  modeAt,
  pocFirstMonth,
  priceBookAt,
  screenOnByDay,
  signalBars,
  todayOf,
  toIndiaTime,
  weekStartOf,
  type FleetState,
  type MinuteSummary,
  type RiderPayRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { priceBooks } from './bookings.js';
import { businessModes } from './business-mode.js';
import { fleetScreens } from './fleet.js';
import { monthBounds } from './rider-pay.js';
import { payZoneAt } from './pay-zone.js';
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

/** A day with how long his screen was on and reporting (business hours; never paid). */
export interface RiderTodayDayOn extends RiderTodayDay {
  readonly screenOnSeconds: number;
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
  readonly today: RiderTodayDayOn;
  /** Monday to today, each day and the total. */
  readonly week: {
    readonly days: readonly RiderTodayDay[];
    readonly countedSeconds: number;
    readonly screenOnSeconds: number;
    readonly earnedPaise: number;
  };
  /** Pay rules in force, for the words the app shows. */
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

/** His stretches on screens (rider pay follows the screen) overlapping [from, to). */
export async function stretchesOf(pool: Q, riderId: string, from: number, to: number) {
  const r = await pool.query<{ screen_id: string; a: string; b: string | null }>(
    `SELECT screen_id, extract(epoch FROM from_at)::bigint AS a,
            extract(epoch FROM next_at)::bigint AS b
       FROM (SELECT screen_id, rider_id, from_at,
                    lead(from_at) OVER (PARTITION BY screen_id ORDER BY from_at) AS next_at
               FROM rider_screens
              WHERE screen_id IN (SELECT screen_id FROM rider_screens WHERE rider_id = $1)
                AND from_at < to_timestamp($3)) s
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

export interface RiderDayFull extends RiderTodayDayOn {
  readonly held: boolean;
  readonly mode: 'poc' | 'regular';
}

/**
 * His business days from `first` (the 1st of a month: the month so far decides the cap) to `last`,
 * each with his counted moving seconds and what it earned by his pay rules, up to `now`; and the
 * rider pay of `last`'s month.
 */
export async function riderDays(
  pool: Q,
  riderId: string,
  first: string,
  last: string,
  now: number,
): Promise<{ days: RiderDayFull[]; rules: RiderPayRules; pocFirst: string | undefined }> {
  const from = opensAt(first);
  const to = Math.min(now, closesAt(last));
  const [books, changes, stretches] = await Promise.all([
    priceBooks(pool),
    businessModes(pool),
    stretchesOf(pool, riderId, from, to),
  ]);
  // Each month's rider pay: the price book in force when it starts, as the pay run takes it (the
  // defaults on a laptop with no price book saved yet; none in force: nothing paid).
  const rulesOf = (month: string) =>
    books.length === 0
      ? DEFAULT_RIDER_PAY_RULES
      : priceBookAt(books, isoAt(monthBounds(month).start))?.riderPay;
  // A minute belongs to whoever rode its screen at its start (as the pay run counts).
  const minutes: MinuteSummary[] = [];
  for (const s of stretches)
    for (const m of await minutesOf(pool, s.screenId, Math.max(from, s.from), Math.min(to, s.to)))
      if (m.minute >= s.from && m.minute < s.to) minutes.push(m);
  const totals = dailyTotals(minutes, undefined, await payZoneAt(pool, changes));
  const on = screenOnByDay(minutes);
  const pocFirst = pocFirstMonth(changes);
  const base = daysBetween(first, last).map((day) => ({
    day,
    countedSeconds: totals.get(day)?.countedSeconds ?? 0,
    // A day not yet begun was not held.
    held:
      opensAt(day) <= now && stretches.some((s) => s.from < closesAt(day) && s.to > opensAt(day)),
    mode: modeAt(changes, opensAt(day)) === 'poc' ? ('poc' as const) : ('regular' as const),
  }));
  const earned = earningsByDay(base, rulesOf, pocFirst);
  return {
    days: base.map((d) => ({
      ...d,
      screenOnSeconds: on.get(d.day) ?? 0,
      earnedPaise: earned.get(d.day) ?? 0,
    })),
    rules: rulesOf(last.slice(0, 7)) ?? DEFAULT_RIDER_PAY_RULES,
    pocFirst,
  };
}

export async function riderToday(pool: Q, riderId: string, now: number): Promise<RiderToday> {
  const today = todayOf(now);
  // The week of today's business day (a Monday 01:00 is still Sunday's: that week).
  const monday = toIndiaTime(new Date(weekStartOf(opensAt(today)) * 1000)).date;

  const { days: all, rules } = await riderDays(
    pool,
    riderId,
    `${monday.slice(0, 7)}-01`,
    today,
    now,
  );
  const week = all.filter((d) => d.day >= monday);
  const perDay = week.map(({ day, countedSeconds, earnedPaise }) => ({
    day,
    countedSeconds,
    earnedPaise,
  }));
  const last = week.at(-1);

  // His screen now: the one on his bike.
  const fitted = await pool.query<{ screen_id: string }>(
    `SELECT f.screen_id FROM screen_fittings f
      WHERE f.rider_id = $1 AND f.from_at <= to_timestamp($2)
        AND NOT EXISTS (SELECT 1 FROM screen_fittings g WHERE g.screen_id = f.screen_id
                         AND g.from_at > f.from_at AND g.from_at <= to_timestamp($2))
      ORDER BY f.from_at DESC LIMIT 1`,
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

  const todayRow: RiderTodayDayOn = last
    ? {
        day: last.day,
        countedSeconds: last.countedSeconds,
        screenOnSeconds: last.screenOnSeconds,
        earnedPaise: last.earnedPaise,
      }
    : { day: today, countedSeconds: 0, screenOnSeconds: 0, earnedPaise: 0 };
  return {
    at: now,
    screen,
    mode: modeAt(await businessModes(pool), now) === 'poc' ? 'poc' : 'regular',
    today: todayRow,
    week: {
      days: perDay,
      countedSeconds: perDay.reduce((n, d) => n + d.countedSeconds, 0),
      screenOnSeconds: week.reduce((n, d) => n + d.screenOnSeconds, 0),
      earnedPaise: perDay.reduce((n, d) => n + d.earnedPaise, 0),
    },
    perMovingHourPaise: rules.perMovingHourPaise,
    monthlyCapHours: rules.monthlyCapHours,
  };
}

export interface RiderRange {
  readonly at: number;
  /** His business day now, by the server's clock (the app's quick picks follow it). */
  readonly today: string;
  readonly from: string;
  readonly to: string;
  /** Every business day from `from` to `to`, in order. */
  readonly days: readonly RiderTodayDayOn[];
  readonly countedSeconds: number;
  readonly screenOnSeconds: number;
  /** Moving-hour pay and the POC base for these days, before tax (the sales share is monthly). */
  readonly earnedPaise: number;
  readonly perMovingHourPaise: number;
  readonly monthlyCapHours: number;
}

/**
 * P4.5: the days a rider picks (at most 92, none after today; checked here again), each with his
 * screen-on and counted moving hours and what they earned, exactly as Today and the month's page
 * work them out: from the 1st of the first month, so the monthly cap falls where the pay run puts it.
 */
export async function riderRange(
  pool: Q,
  riderId: string,
  from: string,
  to: string,
  now: number,
): Promise<RiderRange> {
  const ok = checkDayRange(from, to, todayOf(now));
  if (!ok.ok) throw new RangeError(`Bad range ${from}..${to}: ${ok.why}`);
  const { days: all, rules } = await riderDays(pool, riderId, `${from.slice(0, 7)}-01`, to, now);
  const days = all
    .filter((d) => d.day >= from)
    .map(({ day, countedSeconds, screenOnSeconds, earnedPaise }) => ({
      day,
      countedSeconds,
      screenOnSeconds,
      earnedPaise,
    }));
  const sum = (k: 'countedSeconds' | 'screenOnSeconds' | 'earnedPaise') =>
    days.reduce((n, d) => n + d[k], 0);
  return {
    at: now,
    today: todayOf(now),
    from,
    to,
    days,
    countedSeconds: sum('countedSeconds'),
    screenOnSeconds: sum('screenOnSeconds'),
    earnedPaise: sum('earnedPaise'),
    perMovingHourPaise: rules.perMovingHourPaise,
    monthlyCapHours: rules.monthlyCapHours,
  };
}
