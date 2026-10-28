// P4.4: the rider app's Today page. What a rider earned so far today and this week, worked out by
// the same rules as his pay (rider-pay.ts) so the app never promises more than the pay run gives:
// a POC day pays the month's base spread over its days when he held a screen that day (paid once
// the day ends); a regular day pays ₹25 a counted moving hour, up to the month's cap, rounded as the
// month's total is. His share of sales comes later (known only once the hours his plays sold for
// are settled): the app says so. All amounts before TDS, in whole paise.
import { pocBaseOf, pocDayPaise, pocMonthOf, type RiderPayRules } from './rider-pay.js';

export interface RiderDay {
  /** The business day, "YYYY-MM-DD" (India time). */
  readonly day: string;
  /** Moving seconds counted inside the pay zone and business hours. */
  readonly countedSeconds: number;
  /** He had a screen on his bike at some time that day. */
  readonly held: boolean;
  /** The business switch at the start of that day. */
  readonly mode: 'poc' | 'regular';
}

/** ₹25 an hour on these seconds, to the nearest paisa (halves up): as the pay run works it. */
export function hourlyPaise(rules: RiderPayRules, seconds: number): number {
  return Math.floor((seconds * rules.perMovingHourPaise * 2 + 3600) / 7200);
}

/**
 * Each day's earnings before TDS (the sales share apart), as the pay run will give them. `days` are
 * every business day from the 1st of each month shown up to today, in order; `rulesOf` gives the
 * rider pay in force at the start of a month (as the pay run takes it), or undefined when no price
 * book is (nothing is paid then). Hourly pay is worked out as the month's running total, capped
 * and rounded as the pay run does once a month: a day earns what the month's total grew by, so
 * the days add up exactly to the month and nothing past the cap is shown.
 */
export function earningsByDay(
  days: readonly RiderDay[],
  rulesOf: (month: string) => RiderPayRules | undefined,
  pocFirst: string | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  let month = '';
  let seconds = 0;
  for (const d of days) {
    const m = d.day.slice(0, 7);
    if (m !== month) {
      month = m;
      seconds = 0;
    }
    const rules = rulesOf(m);
    if (!rules) {
      out.set(d.day, 0);
      continue;
    }
    if (d.mode === 'regular') {
      const cap = rules.monthlyCapHours * 3600;
      const before = hourlyPaise(rules, Math.min(seconds, cap));
      seconds += d.countedSeconds;
      out.set(d.day, hourlyPaise(rules, Math.min(seconds, cap)) - before);
      continue;
    }
    const n = pocMonthOf(pocFirst, m);
    if (n === undefined || !d.held) {
      out.set(d.day, 0);
      continue;
    }
    const [y, mo] = m.split('-').map(Number) as [number, number];
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    out.set(d.day, pocDayPaise(pocBaseOf(rules, n), daysInMonth, Number(d.day.slice(8, 10))));
  }
  return out;
}

/** Mobile signal as bars, 0 (none) to 4, from dBm; null when the box has not said. */
export function signalBars(dbm: number | null): number | null {
  if (dbm === null) return null;
  if (dbm >= -85) return 4;
  if (dbm >= -95) return 3;
  if (dbm >= -105) return 2;
  if (dbm >= -115) return 1;
  return 0;
}

/** The business days from `from` to `to` ("YYYY-MM-DD", both included), in order. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** P4.5: the most business days one look at his earnings may cover (about three months). */
export const RANGE_MAX_DAYS = 92;
/** …and how far back it may start (his earnings are shown for about a year). */
export const RANGE_BACK_DAYS = 400;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date "YYYY-MM-DD" (not 30 February), else false. */
export function isDay(text: string): boolean {
  const m = DAY.exec(text);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(t).toISOString().slice(0, 10) === text;
}

/** Whole days from `a` to `b` (both "YYYY-MM-DD"; negative when `b` is earlier). */
export function daysFrom(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export type DayRangeProblem = 'bad-date' | 'backwards' | 'future' | 'too-long' | 'too-old';

/**
 * A rider's own pick of business days, `from` to `to` (both included), checked against `today` (his
 * business day now): real dates, in order, not after today, at most `RANGE_MAX_DAYS` days and
 * starting at most `RANGE_BACK_DAYS` ago. The reason code when refused.
 */
export function checkDayRange(
  from: string,
  to: string,
  today: string,
): { readonly ok: true } | { readonly ok: false; readonly why: DayRangeProblem } {
  if (!isDay(from) || !isDay(to)) return { ok: false, why: 'bad-date' };
  if (to < from) return { ok: false, why: 'backwards' };
  if (to > today) return { ok: false, why: 'future' };
  if (daysFrom(from, to) + 1 > RANGE_MAX_DAYS) return { ok: false, why: 'too-long' };
  if (daysFrom(from, today) > RANGE_BACK_DAYS) return { ok: false, why: 'too-old' };
  return { ok: true };
}
