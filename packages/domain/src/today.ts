// P3.2: the admin Today page — the business day at a glance for the founder and operations:
// bikes online and moving now, hours sold vs delivered today, make-ups owed, refunds this week, and
// open alerts. These are the rules that turn the stored records into those numbers; the limits are
// settings.
import { lineStartsAt } from './bookings.js';
import { businessDayOf, INDIA_OFFSET_MINUTES } from './time.js';

export interface TodayRules {
  /** A screen heard from (any upload or hello) within this is online (minutes). */
  readonly onlineMinutes: number;
  /** A position this recent says whether the bike is moving now (minutes). */
  readonly liveMinutes: number;
}

export const DEFAULT_TODAY_RULES: TodayRules = { onlineMinutes: 5, liveMinutes: 5 };

/** Spare screens the fleet keeps in stock: this share of the screens on bikes (210 = 200 + 5%). */
export interface StockRules {
  readonly spareShare: number;
}

export const DEFAULT_STOCK_RULES: StockRules = { spareShare: 0.05 };

export type FleetState = 'moving' | 'stopped' | 'offline' | 'at-hub';

/**
 * Where one screen stands now. A screen not fitted to a bike is at the hub (in stock or at the
 * fitting centre). A fitted one not heard from within `onlineMinutes` is offline; otherwise it is
 * moving when its latest position (within `liveMinutes`) says so, else stopped. Times in seconds.
 */
export function fleetState(
  s: {
    readonly fitted: boolean;
    readonly lastHeard: number | null;
    readonly lastLive: { readonly t: number; readonly moving: boolean } | null;
  },
  now: number,
  rules: TodayRules = DEFAULT_TODAY_RULES,
): FleetState {
  if (!s.fitted) return 'at-hub';
  if (s.lastHeard === null || now - s.lastHeard > rules.onlineMinutes * 60) return 'offline';
  if (s.lastLive && now - s.lastLive.t <= rules.liveMinutes * 60 && s.lastLive.moving)
    return 'moving';
  return 'stopped';
}

/**
 * The business day the page shows: the one running now, or between 02:00 and 08:00 the one that
 * just ended (its numbers are still being settled).
 */
export function todayOf(nowSeconds: number): string {
  const d = businessDayOf(new Date(nowSeconds * 1000));
  if (d !== null) return d;
  // 02:00–08:00: six hours earlier is inside the day that just ended.
  return businessDayOf(new Date((nowSeconds - 6 * 3600) * 1000)) ?? '';
}

/** Monday 00:00 India time of the week `nowSeconds` falls in (UTC seconds). */
export function weekStartOf(nowSeconds: number): number {
  const offset = INDIA_OFFSET_MINUTES * 60;
  const local = nowSeconds + offset;
  const day = Math.floor(local / 86_400);
  // 1 January 1970 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  const monday = day - ((day + 3) % 7);
  return monday * 86_400 - offset;
}

export interface SoldLine {
  readonly date: string;
  readonly startHour: number;
  readonly bikes: number;
  /** Plays promised. */
  readonly plays: number;
  /** Plays that count so far (the line's own hour; make-ups are shown on their own). */
  readonly counted: number;
}

export interface HoursToday {
  /** Bike-hours sold for the day, and their plays. */
  readonly soldBikeHours: number;
  readonly soldPlays: number;
  /** Of those, the hours already over: what should have been delivered by now. */
  readonly dueBikeHours: number;
  readonly duePlays: number;
  /** Delivered in those hours (each line counted up to its promise). */
  readonly deliveredBikeHours: number;
  readonly deliveredPlays: number;
  /** Bike-hours running in the hour now. */
  readonly runningBikeHours: number;
}

/**
 * Sold vs delivered for a day's sold lines. A line's delivered bike-hours are its bikes times the
 * share of its promised plays that counted (never more than all of them), rounded to tenths so the
 * page never shows false precision.
 */
export function hoursToday(lines: readonly SoldLine[], nowSeconds: number): HoursToday {
  let sold = 0;
  let soldPlays = 0;
  let due = 0;
  let duePlays = 0;
  let deliveredTenths = 0;
  let deliveredPlays = 0;
  let running = 0;
  for (const l of lines) {
    sold += l.bikes;
    soldPlays += l.plays;
    const start = lineStartsAt({ date: l.date, startHour: l.startHour });
    if (nowSeconds >= start + 3600) {
      due += l.bikes;
      duePlays += l.plays;
      const got = Math.min(l.counted, l.plays);
      deliveredPlays += got;
      deliveredTenths += l.plays === 0 ? l.bikes * 10 : Math.floor((l.bikes * 10 * got) / l.plays);
    } else if (nowSeconds >= start) {
      running += l.bikes;
    }
  }
  return {
    soldBikeHours: sold,
    soldPlays,
    dueBikeHours: due,
    duePlays,
    deliveredBikeHours: deliveredTenths / 10,
    deliveredPlays,
    runningBikeHours: running,
  };
}
