// P1.3.4–P1.3.6: a booking's steps, sales holds against manual limits, and the free trial.
import type { BookingLine } from './bookings.js';
import { lineStartsAt } from './bookings.js';
import type { PriceBook } from './price-book.js';

// ---------------------------------------------------------------- steps (P1.3.5)

export type BookingState =
  | 'draft'
  | 'awaiting-payment'
  | 'paid'
  | 'ads-approved'
  | 'running'
  | 'done'
  | 'report-sent'
  | 'cancelled'
  | 'ads-missing';

/** Where each step may go next. */
const NEXT: Readonly<Record<BookingState, readonly BookingState[]>> = {
  draft: ['awaiting-payment', 'cancelled'],
  'awaiting-payment': ['paid', 'cancelled'],
  paid: ['ads-approved', 'ads-missing', 'cancelled'],
  'ads-approved': ['running', 'cancelled'],
  running: ['done'],
  done: ['report-sent'],
  'report-sent': [],
  cancelled: [],
  'ads-missing': [],
};

export interface Timing {
  /** First hour starts and last hour ends (UTC seconds). */
  readonly firstHourAt: number;
  readonly lastHourEndsAt: number;
}

/** Why a step is not allowed now, or undefined when it is. */
export function stepProblem(
  from: BookingState,
  to: BookingState,
  now: number,
  t: Timing,
): string | undefined {
  if (!NEXT[from].includes(to)) return `cannot go from ${from} to ${to}`;
  switch (to) {
    case 'cancelled':
      return now < t.firstHourAt ? undefined : 'can only be cancelled before the first hour';
    case 'ads-approved':
    case 'awaiting-payment':
    case 'paid':
      return now < t.firstHourAt ? undefined : 'the first hour has already started';
    case 'ads-missing':
    case 'running':
      return now >= t.firstHourAt ? undefined : 'the first hour has not started yet';
    case 'done':
      return now >= t.lastHourEndsAt ? undefined : 'the last hour has not ended yet';
    default:
      return undefined;
  }
}

export function timingOf(lines: readonly BookingLine[]): Timing {
  const starts = lines.map(lineStartsAt);
  return { firstHourAt: Math.min(...starts), lastHourEndsAt: Math.max(...starts) + 3600 };
}

// ---------------------------------------------------------------- holds and limits (P1.3.4)

/** A sales hold: inventory kept for a client after a call; no money; ends at `until`. */
export interface Hold {
  readonly holdId: string;
  readonly lines: readonly BookingLine[];
  readonly until: number;
  readonly by: string;
}

export const areaHourKey = (l: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>): string =>
  `${l.areaId}|${l.date}|${l.startHour}`;

export interface Inventory {
  /** Manual limits a super admin set on some area-hours (no limit anywhere else: DECISIONS 21 Oct). */
  readonly limits: ReadonlyMap<string, number>;
  /** Bikes already sold per area-hour (paid or awaiting payment). */
  readonly sold: ReadonlyMap<string, number>;
  readonly holds: readonly Hold[];
}

export interface Shortfall {
  readonly key: string;
  readonly wanted: number;
  readonly free: number;
}

/**
 * Lines that do not fit under a manual limit, counting what is sold and every live hold except
 * `ownHoldId` (when a hold turns into its booking). Area-hours with no limit always fit.
 */
export function capacityProblems(
  lines: readonly BookingLine[],
  inv: Inventory,
  now: number,
  ownHoldId?: string,
): Shortfall[] {
  const held = new Map<string, number>();
  for (const h of inv.holds) {
    if (h.until <= now || h.holdId === ownHoldId) continue;
    for (const l of h.lines) held.set(areaHourKey(l), (held.get(areaHourKey(l)) ?? 0) + l.bikes);
  }
  const wanted = new Map<string, number>();
  for (const l of lines) wanted.set(areaHourKey(l), (wanted.get(areaHourKey(l)) ?? 0) + l.bikes);
  const out: Shortfall[] = [];
  for (const [key, w] of wanted) {
    const limit = inv.limits.get(key);
    if (limit === undefined) continue;
    const free = Math.max(0, limit - (inv.sold.get(key) ?? 0) - (held.get(key) ?? 0));
    if (w > free) out.push({ key, wanted: w, free });
  }
  return out;
}

// ---------------------------------------------------------------- free trial (P1.3.6)

export interface Business {
  readonly gstin?: string;
  readonly phone: string;
}

/** Identities a trial is counted against: the GST number and the phone, each on its own. */
export function trialKeys(b: Business): string[] {
  const keys = [`phone:${b.phone.replace(/\D/g, '').slice(-10)}`];
  if (b.gstin) keys.push(`gstin:${b.gstin.trim().toUpperCase()}`);
  return keys;
}

/**
 * Why this free trial is not allowed, or undefined. One per business (by GST number or phone),
 * one area, at most `trialDays` days and `trialBikeHours` bike-hours. Trials run at the lowest
 * priority on unsold time only (scheduler, P1.4.6) and cost nothing.
 */
export function trialProblem(
  lines: readonly BookingLine[],
  business: Business,
  usedKeys: ReadonlySet<string>,
  book: PriceBook,
): string | undefined {
  if (trialKeys(business).some((k) => usedKeys.has(k)))
    return 'this business has already had its free trial';
  if (lines.length === 0) return 'no hours chosen';
  if (new Set(lines.map((l) => l.areaId)).size !== 1) return 'a trial is in one area only';
  const days = lines.map((l) => Date.parse(`${l.date}T00:00:00Z`) / 86_400_000);
  if (Math.max(...days) - Math.min(...days) + 1 > book.trialDays)
    return `a trial lasts at most ${book.trialDays} days`;
  const bikeHours = lines.reduce((n, l) => n + l.bikes, 0);
  if (bikeHours > book.trialBikeHours)
    return `a trial has at most ${book.trialBikeHours} bike-hours`;
  return undefined;
}
