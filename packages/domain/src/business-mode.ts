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

// ---------------------------------------------------------------- P7.8: the POC's planned length

/**
 * When a POC that starts at `start` (08:00 India time on a 1st) is planned to end: 08:00 India time
 * on the 1st, `months` whole months later (the POC package setting, 3: from 1 Aug, regular business
 * planned from 1 Nov). The POC never ends by itself (Prateek, 28 Oct 2026): a super admin switches
 * back by hand; this date drives the alerts and the early-end guard only.
 */
export function pocPlannedEnd(start: number, months: number): number {
  if (!Number.isSafeInteger(months) || months < 1) throw new RangeError('Months: a whole number');
  const d = toIndiaTime(new Date(start * 1000)).date;
  const [y, m] = d.split('-').map(Number) as [number, number];
  return eightAm(new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10));
}

/** Where the POC stands at `now` (from the switches made), with its planned end. */
export type PocPhase =
  | { readonly phase: 'none' }
  | {
      /** Switched on, not started; on; or switched back to regular business by hand. */
      readonly phase: 'scheduled' | 'running' | 'ended';
      readonly startsAt: number;
      /** Planned: 08:00 India time on the 1st after its months (the switch back is by hand). */
      readonly plannedEnd: number;
      /** When it really ended (the switch back), once it has. */
      readonly endedAt: number | null;
    };

export function pocPhase(changes: readonly ModeChange[], months: number, now: number): PocPhase {
  const i = changes.findIndex((c) => c.mode === 'poc');
  const start = changes[i];
  if (!start) return { phase: 'none' };
  const back = changes.slice(i + 1).find((c) => c.mode === 'regular');
  // A switch back is always made for a day already started (switchCountsFrom): once made, ended.
  const endedAt = back ? back.from : null;
  const phase = endedAt !== null ? 'ended' : now < start.from ? 'scheduled' : 'running';
  return { phase, startsAt: start.from, plannedEnd: pocPlannedEnd(start.from, months), endedAt };
}

/**
 * A switch back to regular business counting from `from` ends the POC early when it counts from
 * before the planned end: before its months are up, or in the 00:00–02:00 tail of the 1st after them
 * (which counts from the last POC day). The days it would cut off (0: not early).
 */
export function pocDaysEarly(p: PocPhase, from: number): number {
  if (p.phase !== 'running' || from >= p.plannedEnd) return 0;
  return Math.max(1, Math.ceil((p.plannedEnd - from) / 86_400));
}

/** "Sat 1 Aug 2026" (India date of a moment). */
function dayText(t: number): string {
  return new Date((t + 19_800) * 1000)
    .toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
    .replace(',', '');
}

export interface PocAlert {
  readonly kind: 'scheduled' | 'starts-today' | 'ends-soon' | 'months-over';
  readonly text: string;
}

/**
 * What super admins are told about the POC in the staff portal (Prateek, 28 Oct 2026): from the
 * switch-on until it starts, that it is scheduled; on the day it starts; from 7 days before its
 * planned end; and from the 1st after its months, while it is still on, to switch back.
 */
export function pocAlerts(p: PocPhase, months: number, now: number): PocAlert[] {
  if (p.phase === 'none' || p.phase === 'ended') return [];
  const lastDay = dayText(p.plannedEnd - 86_400);
  const sameDay = (a: number, b: number) =>
    toIndiaTime(new Date(a * 1000)).date === toIndiaTime(new Date(b * 1000)).date;
  const out: PocAlert[] = [];
  if (p.phase === 'scheduled')
    out.push({
      kind: 'scheduled',
      text: `POC scheduled: starts ${dayText(p.startsAt)}, planned to end ${lastDay} (${months} months); switch to regular business on the morning of ${dayText(p.plannedEnd)}`,
    });
  if (sameDay(now, p.startsAt))
    out.push({
      kind: 'starts-today',
      text: `The POC starts today (${dayText(p.startsAt)}, 8 am): only paid POC months play`,
    });
  if (p.phase === 'running' && now < p.plannedEnd && now >= p.plannedEnd - 7 * 86_400)
    out.push({
      kind: 'ends-soon',
      text: `The POC's planned end is in ${Math.max(1, Math.ceil((p.plannedEnd - now) / 86_400))} days (last day ${lastDay}): switch to regular business on the morning of ${dayText(p.plannedEnd)}`,
    });
  if (p.phase === 'running' && (now >= p.plannedEnd || sameDay(now, p.plannedEnd)))
    out.push({
      kind: 'months-over',
      text: `The POC's ${months} months are over: switch to regular business (from 8 am today, the switch counts from today)`,
    });
  return out;
}
