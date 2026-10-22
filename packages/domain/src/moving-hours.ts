// P1.2.6: moving hours per bike per business day and month, the rider's monthly paid-hour cap, and
// a daily check for odd patterns. Works from the one-minute summaries the screens send (P1.2.4).
import type { MinuteSummary } from './screen-reports.js';
import { businessDayOf, DEFAULT_BUSINESS_HOURS, toIndiaTime, type BusinessHours } from './time.js';

/** Settings (versioned in admin → Prices and rules). */
export interface MovingHourRules {
  /** Rider's paid moving hours are capped at this many a month. */
  readonly monthlyCapHours: number;
  /** A minute "moving" this many seconds… */
  readonly stillMovingSeconds: number;
  /** …but covering less than this many metres is odd. */
  readonly stillMovingMaxM: number;
  /** A minute never moving but covering more than this many metres is odd. */
  readonly movedStillMinM: number;
}

export const DEFAULT_MOVING_HOUR_RULES: MovingHourRules = {
  monthlyCapHours: 260,
  stillMovingSeconds: 45,
  stillMovingMaxM: 100,
  movedStillMinM: 500,
};

export interface Totals {
  /** Seconds the clock ran, inside the business day (08:00–02:00 India time). */
  readonly clockSeconds: number;
  /** Of those, the seconds at places that count (see `counts`). */
  readonly countedSeconds: number;
  readonly movingSeconds: number;
  readonly distanceM: number;
  /** Clock seconds outside business hours: the screen sells nothing then, so they never count. */
  readonly outsideHoursSeconds: number;
}

const ZERO: Totals = {
  clockSeconds: 0,
  countedSeconds: 0,
  movingSeconds: 0,
  distanceM: 0,
  outsideHoursSeconds: 0,
};

/** Business day for a minute outside business hours: the day that ended just before it. */
function dayBefore(minute: number): string {
  return toIndiaTime(new Date((minute - 24 * 3600) * 1000)).date;
}

/**
 * Several summaries for the same minute (e.g. a screen restarted inside a minute) are added up; a
 * minute can never hold more than 60 clock seconds.
 */
function mergeMinutes(minutes: readonly MinuteSummary[]): MinuteSummary[] {
  const byMinute = new Map<number, MinuteSummary>();
  for (const m of minutes) {
    const prev = byMinute.get(m.minute);
    if (!prev) {
      byMinute.set(m.minute, m);
      continue;
    }
    const clockAt: Record<string, number> = { ...prev.clockAt };
    for (const [k, v] of Object.entries(m.clockAt)) clockAt[k] = (clockAt[k] ?? 0) + v;
    const secondsAt: Record<string, number> = { ...prev.secondsAt };
    for (const [k, v] of Object.entries(m.secondsAt)) secondsAt[k] = (secondsAt[k] ?? 0) + v;
    byMinute.set(m.minute, {
      ...prev,
      secondsAt,
      clockAt,
      clockSeconds: prev.clockSeconds + m.clockSeconds,
      movingSeconds: prev.movingSeconds + m.movingSeconds,
      distanceM: prev.distanceM + m.distanceM,
      plays: prev.plays + m.plays,
      people: prev.people + m.people,
    });
  }
  return [...byMinute.values()];
}

/**
 * Totals per business day ("YYYY-MM-DD", India time). `counts` says which places count for pay:
 * in the POC, inside Hyderabad; after it, the allowed areas (DECISIONS, 22 Oct 2026). Only clock
 * seconds inside business hours count (Prateek, 22 Oct 2026); the rest are reported on the
 * business day that ended just before them.
 */
export function dailyTotals(
  minutes: readonly MinuteSummary[],
  counts: (placeKey: string) => boolean = () => true,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS,
): Map<string, Totals> {
  const days = new Map<string, Totals>();
  for (const m of mergeMinutes(minutes)) {
    const clock = Math.min(60, m.clockSeconds);
    const day = businessDayOf(new Date(m.minute * 1000), hours);
    if (day === null) {
      if (clock === 0) continue;
      const before = dayBefore(m.minute);
      const t = days.get(before) ?? ZERO;
      days.set(before, { ...t, outsideHoursSeconds: t.outsideHoursSeconds + clock });
      continue;
    }
    const t = days.get(day) ?? ZERO;
    const rawCounted = Object.entries(m.clockAt).reduce(
      (sum, [k, v]) => sum + (counts(k) ? v : 0),
      0,
    );
    days.set(day, {
      clockSeconds: t.clockSeconds + clock,
      countedSeconds: t.countedSeconds + Math.min(clock, rawCounted),
      movingSeconds: t.movingSeconds + Math.min(60, m.movingSeconds),
      distanceM: t.distanceM + m.distanceM,
      outsideHoursSeconds: t.outsideHoursSeconds,
    });
  }
  return days;
}

export interface MonthHours {
  /** "YYYY-MM" of the business days. */
  readonly month: string;
  readonly countedSeconds: number;
  /** Counted seconds up to the monthly cap: what pay is worked out on. */
  readonly paidSeconds: number;
}

/**
 * Monthly counted and paid seconds. The cap is the rider's: pass the days of one rider (all the
 * bikes they rode that month), not of one bike.
 */
export function monthlyHours(
  days: ReadonlyMap<string, Totals>,
  rules: MovingHourRules = DEFAULT_MOVING_HOUR_RULES,
): MonthHours[] {
  const months = new Map<string, number>();
  for (const [day, t] of days) {
    const month = day.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + t.countedSeconds);
  }
  const cap = rules.monthlyCapHours * 3600;
  return [...months]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, countedSeconds]) => ({
      month,
      countedSeconds,
      paidSeconds: Math.min(countedSeconds, cap),
    }));
}

export type OddMinute = {
  readonly minute: number;
  readonly kind: 'moving-but-still' | 'still-but-moved';
};

/** P1.2.6 daily check: minutes where the clock and the GPS disagree, for a person to look at. */
export function oddMinutes(
  minutes: readonly MinuteSummary[],
  rules: MovingHourRules = DEFAULT_MOVING_HOUR_RULES,
): OddMinute[] {
  const odd: OddMinute[] = [];
  for (const m of minutes) {
    if (m.movingSeconds >= rules.stillMovingSeconds && m.distanceM < rules.stillMovingMaxM) {
      odd.push({ minute: m.minute, kind: 'moving-but-still' });
    } else if (m.movingSeconds === 0 && m.distanceM > rules.movedStillMinM) {
      odd.push({ minute: m.minute, kind: 'still-but-moved' });
    }
  }
  return odd;
}
