// P5.4: how a brand books on the portal. It picks areas (RECALL's shapes), hours (single hours or
// ready-made picks), the days of the week, a start date and how many weeks, and how many bikes each
// hour; optionally the same plan again every month for 6 or 12 months (the deal offer). The plan
// becomes booking lines (one per area, day and hour), priced by the price book as any booking is.
import type { BrandSignInRules } from './brand-sign-in.js';
import type { BookingLine } from './bookings.js';
import type { PriceBook } from './price-book.js';

/** Ready-made hour picks (start hours, India time; 24 = midnight, 25 = 01:00). */
export const HOUR_PICKS = [
  { key: 'morning-rush', label: 'Morning rush', hours: [8, 9, 10] },
  { key: 'lunch', label: 'Lunch', hours: [12, 13, 14] },
  { key: 'evening-rush', label: 'Evening rush', hours: [17, 18, 19] },
  { key: 'dinner', label: 'Dinner', hours: [20, 21, 22] },
  { key: 'late-night', label: 'Late night', hours: [23, 24, 25] },
] as const;

/** Every hour a brand can pick: 08:00 to 01:00. */
export const PORTAL_HOURS = Array.from({ length: 18 }, (_, i) => i + 8);

/** "8 am", "12 noon", "12 midnight", "1 am" for a start hour. */
export function hourLabel(h: number): string {
  const x = h % 24;
  if (x === 0) return '12 midnight';
  if (x === 12) return '12 noon';
  return x < 12 ? `${x} am` : `${x - 12} pm`;
}

export interface PortalPlan {
  readonly areaIds: readonly string[];
  readonly hours: readonly number[];
  /** Days of the week it plays: 1 Monday … 7 Sunday. */
  readonly weekdays: readonly number[];
  /** The first day it may play ("YYYY-MM-DD", India). */
  readonly startDate: string;
  readonly weeks: number;
  /** Bikes each hour, in each area. */
  readonly bikes: number;
  /** 1: once; 6 or 12: the same weeks again every month (the deal offer). */
  readonly repeatMonths: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A real calendar date ("2027-02-30" is not). */
const realDate = (d: string) => DATE.test(d) && !Number.isNaN(utc(d)) && iso(utc(d)) === d;

/** A plan may make at most this many booking lines (a typing slip, not a campaign). */
export const MAX_PORTAL_LINES = 5_000;

/** How many lines a plan makes, worked out without making them. */
export function planLineCount(p: PortalPlan): number {
  return (
    new Set(p.areaIds).size *
    new Set(p.hours).size *
    new Set(p.weekdays).size *
    Math.max(0, p.weeks) *
    Math.max(0, p.repeatMonths)
  );
}

/**
 * Where month `months` of a deal starts: the same day of the month, or, in a month too short for
 * it (the 31st in September), the 1st of the next (as the deal's spread check counts months).
 */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return iso(d <= last ? Date.UTC(y, m - 1 + months, d) : Date.UTC(y, m + months, 1));
}

/** What is wrong with a plan, in words the brand can act on; empty when it can be priced. */
export function planProblems(
  p: PortalPlan,
  book: PriceBook,
  limits: Pick<BrandSignInRules, 'maxBikesPerHour' | 'maxWeeks'>,
): string[] {
  const out: string[] = [];
  if (p.areaIds.length === 0) out.push('Pick at least one area');
  if (p.hours.length === 0) out.push('Pick at least one hour');
  if (p.weekdays.length === 0) out.push('Pick at least one day of the week');
  if (p.hours.some((h) => !PORTAL_HOURS.includes(h))) out.push('Hours run from 8 am to 1 am');
  if (p.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7))
    out.push('Days of the week: Monday to Sunday');
  if (!realDate(p.startDate)) out.push('Pick a start date');
  if (!Number.isInteger(p.weeks) || p.weeks < 1 || p.weeks > limits.maxWeeks)
    out.push(`From 1 to ${limits.maxWeeks} weeks (longer through our team)`);
  if (
    !Number.isInteger(p.bikes) ||
    p.bikes < book.minBikesPerLine ||
    p.bikes > limits.maxBikesPerHour
  )
    out.push(`From ${book.minBikesPerLine} to ${limits.maxBikesPerHour} bikes each hour`);
  if (p.repeatMonths !== 1 && book.repeatOffersBp[p.repeatMonths] === undefined)
    out.push('Repeat for 6 or 12 months, or not at all');
  // Each month's weeks must fit inside that month (the deal spreads hours evenly).
  if (p.repeatMonths > 1 && p.weeks > 4) out.push('A monthly repeat runs up to 4 weeks a month');
  if (out.length === 0 && planLineCount(p) > MAX_PORTAL_LINES)
    out.push('Too many hours for one booking: book it in parts, or call us');
  return out;
}

/** The plan's booking lines: each area, each chosen hour, each chosen day of its weeks and months. */
export function planLines(p: PortalPlan): BookingLine[] {
  const lines: BookingLine[] = [];
  const days = new Set(p.weekdays);
  const areas = [...new Set(p.areaIds)].sort();
  const hours = [...new Set(p.hours)].sort((a, b) => a - b);
  if (days.size === 0 || !realDate(p.startDate) || planLineCount(p) > MAX_PORTAL_LINES)
    return lines;
  // Months are counted from the first day that plays (as the deal's spread check counts them).
  let first = p.startDate;
  while (!days.has(new Date(`${first}T00:00:00Z`).getUTCDay() || 7))
    first = iso(utc(first) + 86_400_000);
  for (let m = 0; m < p.repeatMonths; m++) {
    const from = utc(addMonths(first, m));
    for (let i = 0; i < p.weeks * 7; i++) {
      const date = iso(from + i * 86_400_000);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
      if (!days.has(dow)) continue;
      for (const areaId of areas)
        for (const startHour of hours) lines.push({ areaId, date, startHour, bikes: p.bikes });
    }
  }
  return lines;
}

/** The earliest day a portal booking may start: the lead days after today (India). */
export function earliestStart(now: number, book: PriceBook): string {
  return iso((now + 330 * 60) * 1000 + (book.portalLeadDays + 1) * 86_400_000);
}
