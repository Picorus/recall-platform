// P1.3.7: how many bikes an area-hour can be sold for, and what to offer when a request does not fit
// (Prateek, 22 Oct 2026). During the POC all 200 bikes run and nothing is capped by a forecast; after
// the POC the sellable number comes from how many bikes were really there in past weeks.
import type { AreaVersion } from './areas.js';
import type { BookingLine } from './bookings.js';
import { distanceMeters, type LatLng } from './geo.js';

/** Settings, kept in the price book (admin → Prices and rules). */
export interface CapacityRules {
  /** 'poc': only manual limits; 'forecast': sell what past weeks show the area can carry. */
  readonly mode: 'poc' | 'forecast';
  /** Weeks of history looked at, and in how many of them the level must have been reached. */
  readonly lookbackWeeks: number;
  readonly levelWeeks: number;
  /** Kept back for make-ups, basis points (1000 = 10%). */
  readonly makeUpMarginBp: number;
  /** Fewer weeks of history than this: use the super admin's starting estimate instead. */
  readonly minWeeks: number;
  /** A bike counts as "there" in an hour when it spent at least this long inside the area. */
  readonly minSecondsInside: number;
  /** Suggestions look for other areas within this distance (centre to centre). */
  readonly nearbyMeters: number;
}

export const DEFAULT_CAPACITY_RULES: CapacityRules = {
  mode: 'poc',
  lookbackWeeks: 5,
  levelWeeks: 4,
  makeUpMarginBp: 1_000,
  minWeeks: 4,
  minSecondsInside: 300,
  nearbyMeters: 5_000,
};

/** One past week of one area at one weekday and start hour. */
export interface WeekSupply {
  /** Business date of that week's day, "YYYY-MM-DD". */
  readonly date: string;
  /** Different bikes that spent at least `minSecondsInside` inside the area in the hour. */
  readonly distinctBikes: number;
  /** All moving-clock seconds inside the area in the hour, every bike together. */
  readonly bikeSeconds: number;
}

/**
 * Bikes that can be sold in this area-hour after the POC. Each sold bike needs a full bike-hour of
 * plays and a bike of its own, so a week's capacity is the smaller of the two. The level reached in
 * `levelWeeks` of the last `lookbackWeeks` is used, less the make-up margin. With too little history,
 * the starting estimate (or 0 when there is none: nothing is sold blind).
 */
export function sellableBikes(
  weeks: readonly WeekSupply[],
  rules: CapacityRules,
  startingEstimate?: number,
): number {
  const recent = [...weeks]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, rules.lookbackWeeks);
  if (recent.length < rules.minWeeks) return Math.max(0, Math.floor(startingEstimate ?? 0));
  const levels = recent
    .map((w) => Math.min(w.distinctBikes, Math.floor(w.bikeSeconds / 3600)))
    .sort((a, b) => b - a);
  const level = levels[Math.min(rules.levelWeeks, levels.length) - 1] ?? 0;
  return Math.floor((level * (10_000 - rules.makeUpMarginBp)) / 10_000);
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * The past weeks to look at for a business date: the same weekday, newest first, all before `today`
 * (today's hour may not be over yet), none before `firstDate` (when the fleet was reporting and the
 * area was on). A week in this list with no bikes in it counts as 0 bikes, not as "no history".
 */
export function pastWeekDates(
  date: string,
  today: string,
  lookbackWeeks: number,
  firstDate: string,
): string[] {
  const days = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const k = Math.max(0, Math.floor((days(date) - days(today)) / 7) + 1);
  return Array.from({ length: lookbackWeeks }, (_, i) => addDays(date, -7 * (k + i))).filter(
    (d) => d >= firstDate,
  );
}

// ---------------------------------------------------------------- offers and suggestions

/** Rough centre of an area, for "nearby". */
export function centreOf(area: AreaVersion): LatLng {
  const n = area.ring.length || 1;
  return {
    lat: area.ring.reduce((s, p) => s + p.lat, 0) / n,
    lng: area.ring.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** For each area, the other areas that are on, nearest first, within `nearbyMeters`. */
export function nearbyAreas(
  areas: readonly AreaVersion[],
  nearbyMeters: number,
): Map<string, string[]> {
  const on = areas.filter((a) => a.active && !a.draft);
  const out = new Map<string, string[]>();
  for (const a of on) {
    const c = centreOf(a);
    out.set(
      a.areaId,
      on
        .filter((b) => b.areaId !== a.areaId)
        .map((b) => ({ id: b.areaId, d: distanceMeters(c, centreOf(b)) }))
        .filter((x) => x.d <= nearbyMeters)
        .sort((x, y) => x.d - y.d || (x.id < y.id ? -1 : 1))
        .map((x) => x.id),
    );
  }
  return out;
}

export interface Suggestion {
  /** A line the brand can take instead, already sized to what is free (up to what is missing). */
  readonly line: BookingLine;
  readonly why: 'nearby area' | 'other hour' | 'other day';
}

export interface Offer {
  /** The request, cut down to what fits. Lines that fit fully are unchanged. */
  readonly fits: readonly BookingLine[];
  /** For each line that does not fit fully: how many bikes are missing, and other places to put them. */
  readonly short: readonly {
    readonly line: BookingLine;
    readonly missing: number;
    readonly suggestions: readonly Suggestion[];
  }[];
}

/** Other places for a line's missing bikes, in the order they are offered. */
export function candidateSlots(
  l: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>,
  nearby: ReadonlyMap<string, readonly string[]>,
): { at: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>; why: Suggestion['why'] }[] {
  const base = { areaId: l.areaId, date: l.date, startHour: l.startHour };
  return [
    ...(nearby.get(l.areaId) ?? []).map((areaId) => ({
      at: { ...base, areaId },
      why: 'nearby area' as const,
    })),
    ...[1, 2, -1]
      .map((d) => l.startHour + d)
      .filter((h) => h >= 8 && h <= 25)
      .map((startHour) => ({ at: { ...base, startHour }, why: 'other hour' as const })),
    ...[7, 1, 2].map((d) => ({
      at: { ...base, date: addDays(l.date, d) },
      why: 'other day' as const,
    })),
  ];
}

/**
 * What can be committed now, and suggestions for the rest. `free(line)` says how many bikes are free
 * at that area-hour (undefined = no limit). Suggestions never offer fewer than `minBikes`.
 */
export function offerFor(
  lines: readonly BookingLine[],
  free: (at: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>) => number | undefined,
  nearby: ReadonlyMap<string, readonly string[]>,
  minBikes: number,
  maxSuggestions = 5,
): Offer {
  const fits: BookingLine[] = [];
  const short: Offer['short'][number][] = [];
  const used = new Map<string, number>();
  const key = (l: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>) =>
    `${l.areaId}|${l.date}|${l.startHour}`;
  const left = (l: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>) => {
    const f = free(l);
    return f === undefined ? Number.POSITIVE_INFINITY : Math.max(0, f - (used.get(key(l)) ?? 0));
  };
  // First what fits, for every line; only then suggestions, so a suggestion never offers bikes a
  // later line of the same request already takes, and two suggestions never offer the same bikes.
  const committed = lines.map((l) => {
    const take = Math.min(l.bikes, left(l));
    if (take < minBikes) return 0;
    fits.push({ ...l, bikes: take });
    used.set(key(l), (used.get(key(l)) ?? 0) + take);
    return take;
  });
  const asked = new Set(lines.map(key));
  lines.forEach((l, i) => {
    const missing = l.bikes - (committed[i] ?? 0);
    if (missing === 0) return;
    const suggestions: Suggestion[] = [];
    for (const { at, why } of candidateSlots(l, nearby)) {
      if (suggestions.length >= maxSuggestions) break;
      // A slot the request already has would be a second line on the same hour: not offered.
      if (asked.has(key(at))) continue;
      const room = Math.min(missing, left(at));
      if (room < minBikes) continue;
      suggestions.push({
        line: { areaId: at.areaId, date: at.date, startHour: at.startHour, bikes: room },
        why,
      });
      used.set(key(at), (used.get(key(at)) ?? 0) + room);
    }
    short.push({ line: l, missing, suggestions });
  });
  return { fits, short };
}
