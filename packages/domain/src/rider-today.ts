// P4.4: the rider app's Today page. What a rider earned so far today and this week, worked out by
// the same rules as his pay (rider-pay.ts) so the app never promises more than the pay run gives:
// a POC day pays the month's base spread over its days when he held a screen that day; a regular
// day pays ₹25 a counted moving hour. His share of sales comes later (it is known only once the
// hours his plays sold for are settled), and the monthly cap on hours applies over the month: the
// app says so. All amounts before TDS, in whole paise.
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

/** One day's earnings before TDS (the sales share apart). `pocFirst`: the POC's first month. */
export function dayEarnings(
  rules: RiderPayRules,
  pocFirst: string | undefined,
  d: RiderDay,
): number {
  if (d.mode === 'regular') return hourlyPaise(rules, d.countedSeconds);
  const month = d.day.slice(0, 7);
  const n = pocMonthOf(pocFirst, month);
  if (n === undefined || !d.held) return 0;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return pocDayPaise(pocBaseOf(rules, n), daysInMonth, Number(d.day.slice(8, 10)));
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
