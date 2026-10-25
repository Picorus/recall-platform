// The business switch (Prateek, 24 Oct 2026): a super admin flips the whole business between the
// POC and regular business in the admin portal. A switch counts from the start of the business day
// it is made in (the day of the switch is under the new mode). Rider pay follows it now; the brand
// side will read the same switch.
import { businessDayOf, toIndiaTime } from './time.js';

export type BusinessMode = 'poc' | 'regular';

export interface ModeChange {
  readonly mode: BusinessMode;
  /** UTC seconds: from when it counts. */
  readonly from: number;
}

/** The mode at a moment: the latest change at or before it; regular business before any. */
export function modeAt(changes: readonly ModeChange[], t: number): BusinessMode {
  let mode: BusinessMode = 'regular';
  for (const c of changes) if (c.from <= t) mode = c.mode;
  return mode;
}

/** 08:00 India time on a date, in UTC seconds. */
const eightAm = (date: string) => Date.parse(`${date}T02:30:00Z`) / 1000;

/**
 * From when a switch made at `now` counts: the start (08:00 India time) of the business day it is
 * made in; made between 02:00 and 08:00, the business day about to start.
 */
export function switchCountsFrom(now: number): number {
  const day = businessDayOf(new Date(now * 1000));
  return eightAm(day ?? toIndiaTime(new Date(now * 1000)).date);
}

/**
 * From when switching the POC on counts: always the 1st of a month at 08:00 India time (today's
 * business day if it is the 1st, otherwise the next 1st), so POC month 1 is a full month and the
 * three months add up exactly (review, 25 Oct 2026). A switch-on in the 23:00–02:00 tail of the
 * last day goes to the 1st.
 */
export function pocStartsFrom(now: number): number {
  const day = businessDayOf(new Date(now * 1000)) ?? toIndiaTime(new Date(now * 1000)).date;
  if (day.endsWith('-01')) return eightAm(day);
  const [y, m] = day.split('-').map(Number) as [number, number];
  return eightAm(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10));
}

/** The month ("YYYY-MM", India time) the POC was first switched on, if it ever was. */
export function pocFirstMonth(changes: readonly ModeChange[]): string | undefined {
  const first = changes.find((c) => c.mode === 'poc');
  return first === undefined
    ? undefined
    : toIndiaTime(new Date(first.from * 1000)).date.slice(0, 7);
}

/**
 * When the POC ended: the first switch to regular business after it was on (undefined while it
 * runs, or if it never ran). The POC runs once: it can never be switched on again after this.
 */
export function pocEndedAt(changes: readonly ModeChange[]): number | undefined {
  const start = changes.findIndex((c) => c.mode === 'poc');
  if (start < 0) return undefined;
  return changes.slice(start).find((c) => c.mode === 'regular')?.from;
}
