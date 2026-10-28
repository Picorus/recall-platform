// P4.5: the days a rider looks at on Earnings. Quick picks (today, yesterday, this week, last week,
// this month) and his own from–to pick on a small calendar. Days are business days, "YYYY-MM-DD"
// in India time (a ride at 01:00 counts for the day before); weeks start on Monday. The server
// checks every pick again (at most 92 days, none after today, none older than about a year).
import { RANGE_BACK_DAYS, RANGE_MAX_DAYS } from '@recall/domain';

export { RANGE_MAX_DAYS };

export interface DayRange {
  readonly from: string;
  readonly to: string;
}

export const PRESETS = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth'] as const;
export type Preset = (typeof PRESETS)[number];

const at = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The day `n` days after `day` (before, when negative). */
export function addDays(day: string, n: number): string {
  return dayAt(at(day) + n * 86_400_000);
}

/** Days from `from` to `to`, both counted (1 for a single day). */
export function daysIn(r: DayRange): number {
  return Math.round((at(r.to) - at(r.from)) / 86_400_000) + 1;
}

/** 0 for Monday … 6 for Sunday. */
export function weekdayOf(day: string): number {
  return (new Date(at(day)).getUTCDay() + 6) % 7;
}

/** The Monday of the week `day` is in. */
export function mondayOf(day: string): string {
  return addDays(day, -weekdayOf(day));
}

/** The days a quick pick stands for, on business day `today`. */
export function presetRange(p: Preset, today: string): DayRange {
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'thisWeek':
      return { from: mondayOf(today), to: today };
    case 'lastWeek': {
      const m = addDays(mondayOf(today), -7);
      return { from: m, to: addDays(m, 6) };
    }
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/** The quick pick these days are, if any (so a calendar pick of "this week" lights its chip). */
export function presetOf(r: DayRange, today: string): Preset | undefined {
  return PRESETS.find((p) => {
    const q = presetRange(p, today);
    return q.from === r.from && q.to === r.to;
  });
}

/** The earliest day he may pick. */
export function earliestDay(today: string): string {
  return addDays(today, -RANGE_BACK_DAYS);
}

/** "2027-08" moved by `n` months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** A month as calendar rows of 7 (Monday first): each cell a day, or null outside the month. */
export function monthGrid(month: string): (string | null)[][] {
  const first = `${month}-01`;
  const lead = weekdayOf(first);
  const days: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) days.push(d);
  while (days.length % 7 !== 0) days.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));
  return rows;
}

/** What he has tapped on the calendar so far: a first day, then a last. */
export interface Picking {
  readonly from?: string;
  readonly to?: string;
}

/**
 * A tap on a day: the first tap is the first day; the second the last (tapped earlier than the
 * first, the two swap); a tap after both starts again.
 */
export function tapDay(p: Picking, day: string): Picking {
  if (!p.from || p.to) return { from: day };
  return day < p.from ? { from: day, to: p.from } : { from: p.from, to: day };
}

/**
 * Whether a day can be tapped: not after today, not older than the earliest, and once the first
 * day is tapped, not so far from it that the pick would pass 92 days.
 */
export function canTap(p: Picking, day: string, today: string): boolean {
  if (day > today || day < earliestDay(today)) return false;
  if (p.from && !p.to)
    return (
      daysIn(day < p.from ? { from: day, to: p.from } : { from: p.from, to: day }) <= RANGE_MAX_DAYS
    );
  return true;
}

/** "28/10" */
export const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** "21/10 – 27/10", or "28/10" for a single day. */
export function rangeText(r: DayRange): string {
  return r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} – ${shortDay(r.to)}`;
}
