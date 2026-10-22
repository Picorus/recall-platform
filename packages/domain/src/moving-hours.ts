// P1.2.6: moving hours per bike per business day and month, the rider's monthly paid-hour cap, and
// a daily check for odd patterns. Works from the one-minute summaries the screens send (P1.2.4).
import type { MinuteSummary } from './screen-reports.js';
import { businessDayOf } from './time.js';

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

/**
 * Totals per business day ("YYYY-MM-DD", India time). `counts` says which places count for pay:
 * in the POC, inside Hyderabad; after it, the allowed areas (DECISIONS, 22 Oct 2026).
 */
export function dailyTotals(
  minutes: readonly MinuteSummary[],
  counts: (placeKey: string) => boolean = () => true,
): Map<string, Totals> {
  const days = new Map<string, Totals>();
  const seen = new Set<number>();
  for (const m of minutes) {
    if (seen.has(m.minute)) throw new RangeError(`Minute ${m.minute} given twice`);
    seen.add(m.minute);
    const day = businessDayOf(new Date(m.minute * 1000));
    if (day === null) continue;
    const t = days.get(day) ?? ZERO;
    const counted = Object.entries(m.clockAt).reduce((sum, [k, v]) => sum + (counts(k) ? v : 0), 0);
    days.set(day, {
      clockSeconds: t.clockSeconds + m.clockSeconds,
      countedSeconds: t.countedSeconds + counted,
      movingSeconds: t.movingSeconds + m.movingSeconds,
      distanceM: t.distanceM + m.distanceM,
      outsideHoursSeconds: t.outsideHoursSeconds,
    });
  }
  // Clock seconds outside business hours are reported on the day they follow.
  for (const m of minutes) {
    if (businessDayOf(new Date(m.minute * 1000)) !== null || m.clockSeconds === 0) continue;
    const day = businessDayOf(new Date((m.minute + 6 * 3600) * 1000)) ?? 'unknown';
    const t = days.get(day) ?? ZERO;
    days.set(day, { ...t, outsideHoursSeconds: t.outsideHoursSeconds + m.clockSeconds });
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
