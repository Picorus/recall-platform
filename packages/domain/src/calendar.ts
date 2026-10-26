// P3.7: the inventory calendar. For each area-hour of a week: bike-hours booked, held for clients,
// the limit (a super admin's manual limit, or after the POC the forecast), what is still free, the
// bikes usually seen there, and for hours already over what was delivered. Sales holds a client's
// hours, days and bikes (no money; ends at a set time or when released; turns into a booking).
import type { BookingLine } from './bookings.js';
import { lineStartsAt } from './bookings.js';
import type { CapacityRules, WeekSupply } from './supply.js';

/** Start hours sold, India time (24 = midnight, 25 = 01:00). */
export const CALENDAR_HOURS: readonly number[] = Array.from({ length: 18 }, (_, i) => i + 8);

/** The most a hold may cover in one go: a week of every hour. */
export const MAX_HOLD_LINES = 7 * 18;

/** `n` business dates from `from` ("YYYY-MM-DD"), one a day. */
export function calendarDays(from: string, n: number): string[] {
  lineStartsAt({ date: from, startHour: 8 }); // refuses anything that is not a real day
  const at = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    new Date(at + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/**
 * Bikes usually seen in an area-hour: the level past weeks reached (as the forecast reads it, before
 * the make-up margin); null with too little history.
 */
export function usualBikes(weeks: readonly WeekSupply[], rules: CapacityRules): number | null {
  const recent = [...weeks]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, rules.lookbackWeeks);
  if (recent.length < rules.minWeeks) return null;
  const levels = recent
    .map((w) => Math.min(w.distinctBikes, Math.floor(w.bikeSeconds / 3600)))
    .sort((a, b) => b - a);
  return levels[Math.min(rules.levelWeeks, levels.length) - 1] ?? 0;
}

/** A paid line in an area-hour, with the plays it promised and those that counted so far. */
export interface DeliveredLine {
  readonly bikes: number;
  readonly plays: number;
  readonly counted: number;
}

/**
 * Bike-hours delivered, in tenths: each line's bikes × the share of its promised plays that counted
 * (never above 100%), as on the Today page.
 */
export function deliveredTenths(lines: readonly DeliveredLine[]): number {
  let t = 0;
  for (const l of lines) {
    const got = Math.min(l.counted, l.plays);
    t += l.plays === 0 ? l.bikes * 10 : Math.floor((l.bikes * 10 * got) / l.plays);
  }
  return t;
}

export interface CalendarCell {
  readonly date: string;
  readonly startHour: number;
  /** Bikes taken by bookings (awaiting payment, paid or running; not drafts or cancelled). */
  readonly booked: number;
  /** Bikes kept by live holds (not yet turned into a booking). */
  readonly held: number;
  /** A super admin's manual limit, if set. */
  readonly manualLimit: number | null;
  /** The limit in force: the manual one, else the forecast after the POC; null = no limit. */
  readonly limit: number | null;
  /** Bikes still free to sell; null when there is no limit. */
  readonly free: number | null;
  /** Bikes usually seen there (past weeks); null with too little history. */
  readonly usual: number | null;
  /** For hours already over: bike-hours delivered, in tenths; null before the hour ends. */
  readonly deliveredTenths: number | null;
}

export function cellOf(x: {
  date: string;
  startHour: number;
  booked: number;
  held: number;
  manualLimit: number | null;
  forecast: number | null;
  usual: number | null;
  delivered: readonly DeliveredLine[];
  now: number;
}): CalendarCell {
  const limit = x.manualLimit ?? x.forecast;
  const over = x.now >= lineStartsAt({ date: x.date, startHour: x.startHour }) + 3600;
  return {
    date: x.date,
    startHour: x.startHour,
    booked: x.booked,
    held: x.held,
    manualLimit: x.manualLimit,
    limit,
    free: limit === null ? null : Math.max(0, limit - x.booked - x.held),
    usual: x.usual,
    deliveredTenths: over ? deliveredTenths(x.delivered) : null,
  };
}

/** A hold's lines: every chosen day × every chosen hour, the same bikes, in one area. */
export function holdLinesOf(
  areaId: string,
  dates: readonly string[],
  hours: readonly number[],
  bikes: number,
): BookingLine[] {
  if (!Number.isSafeInteger(bikes) || bikes < 1)
    throw new RangeError('Bikes must be a whole number, 1 or more');
  const days = [...new Set(dates)].sort();
  const hrs = [...new Set(hours)].sort((a, b) => a - b);
  if (days.length === 0 || hrs.length === 0)
    throw new RangeError('Choose at least one day and hour');
  for (const h of hrs)
    if (!CALENDAR_HOURS.includes(h)) throw new RangeError(`${h} is not a start hour (8 to 25)`);
  if (days.length * hrs.length > MAX_HOLD_LINES)
    throw new RangeError(`A hold covers at most ${MAX_HOLD_LINES} area-hours (a week)`);
  const lines = days.flatMap((date) =>
    hrs.map((startHour) => ({ areaId, date, startHour, bikes })),
  );
  for (const l of lines) lineStartsAt(l); // refuses a date that is not a real day
  return lines;
}
