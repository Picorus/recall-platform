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
