// The sums and labels behind the small charts and folds (P7.7.7). Pure: no React, no browser, so the
// server, the browser and the tests all get the same answer. Times are UTC seconds; every label is
// India time (UTC+5:30, no summer time).

const IST_S = 19_800;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A step of 1, 2 or 5 times a power of ten, so axis numbers are round. */
function niceStep(rough: number): number {
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const m = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return m * mag;
}

/** Floating dust off a multiple of the step (0.30000000000000004 → 0.3). */
const clean = (x: number) => Number(x.toPrecision(12));

export interface Ticks {
  /** The axis runs from `min` to `max`; both are ticks. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/**
 * Round axis numbers covering the values, with about `target` steps: 0 / 50 / 100 / 150 rather than
 * 0 / 47 / 94. The axis always includes 0 (bars grow from it). Counts and paise are whole, so the
 * step is at least 1 unless `whole` is false.
 */
export function niceTicks(values: readonly number[], target = 4, whole = true): Ticks {
  const finite = values.filter((v) => Number.isFinite(v));
  let lo = Math.min(0, ...finite);
  let hi = Math.max(0, ...finite);
  if (hi === lo) hi = lo + (whole ? Math.max(1, target) : 1);
  let step = niceStep((hi - lo) / Math.max(1, target));
  if (whole) step = Math.max(1, Math.round(step));
  lo = clean(Math.floor(lo / step) * step);
  hi = clean(Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let i = 0; clean(lo + i * step) <= hi; i++) ticks.push(clean(lo + i * step));
  return { min: lo, max: hi, step, ticks };
}

/** Where a value sits on the axis, 0 (bottom) to 100 (top), clamped. */
export function position(value: number, t: Pick<Ticks, 'min' | 'max'>): number {
  if (t.max === t.min) return 0;
  return Math.min(100, Math.max(0, ((value - t.min) / (t.max - t.min)) * 100));
}

/**
 * A number short enough for an axis, Indian style: 950, 1.2K, 12K, 1.2L (lakh), 3.4Cr (crore).
 * One decimal under ten of the unit, none above; never "1.0K".
 */
export function compactIndian(n: number): string {
  const neg = n < 0;
  const a = Math.abs(n);
  const units: readonly (readonly [number, string])[] = [
    [10_000_000, 'Cr'],
    [100_000, 'L'],
    [1_000, 'K'],
  ];
  let out = Math.round(a).toLocaleString('en-IN');
  if (a < 1000 && !Number.isInteger(a)) out = String(clean(Math.round(a * 10) / 10));
  for (const [size, unit] of units) {
    if (a >= size) {
      const v = a / size;
      const shown = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
      out = `${shown}${unit}`;
      break;
    }
  }
  return `${neg ? '−' : ''}${out}`;
}

/** Whole paise as a short rupee amount for an axis: "₹0", "₹950", "₹1.2L". Display only. */
export function rupeesShort(paise: number): string {
  const r = Math.trunc(paise / 100);
  return `${r < 0 ? '−' : ''}₹${compactIndian(Math.abs(r))}`;
}

/** The India date ("2026-10-28") of a UTC time. */
export const indiaDate = (t: number): string =>
  new Date((t + IST_S) * 1000).toISOString().slice(0, 10);

/** The India month ("2026-10") of a UTC time. */
export const indiaMonthOf = (t: number): string => indiaDate(t).slice(0, 7);

/**
 * The business day of a UTC time: 08:00–02:00 India time, so 23:00–02:00 belongs to the day it
 * started (hard rule 5). No ads run 02:00–08:00; those hours fall on the new date.
 */
export const businessDay = (t: number): string => indiaDate(t - 2 * 3600);

/** "28 Oct" from "2026-10-28" (with the year when `withYear`). */
export function dayLabel(date: string, withYear = false): string {
  const m = MONTHS[Number(date.slice(5, 7)) - 1] ?? '';
  return `${Number(date.slice(8, 10))} ${m}${withYear ? ` ${date.slice(0, 4)}` : ''}`;
}

/** "Oct" from "2026-10" ("Oct 2026" when `withYear`). */
export function monthLabel(month: string, withYear = false): string {
  const m = MONTHS[Number(month.slice(5, 7)) - 1] ?? '';
  return withYear ? `${m} ${month.slice(0, 4)}` : m;
}

/** "8am", "12pm", "11pm", "1am" for an India hour; 24 and 25 (after midnight) are 12am and 1am. */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${h < 12 ? 'am' : 'pm'}`;
}

/** The months from `first` to `last` ("YYYY-MM"), in order. */
export function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number) as [number, number];
  const end = last.slice(0, 7);
  for (let i = 0; i < 240; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/**
 * Adds values up by a key of their time (an India day or month), with every key in `keys` present
 * (0 when nothing fell in it) and nothing outside them. Whole numbers in, whole numbers out.
 */
function sumByKey(
  items: readonly { readonly at: number; readonly value: number }[],
  keys: readonly string[],
  keyOf: (t: number) => string,
): { key: string; value: number }[] {
  const sums = new Map(keys.map((k) => [k, 0]));
  for (const x of items) {
    const k = keyOf(x.at);
    const was = sums.get(k);
    if (was !== undefined) sums.set(k, was + x.value);
  }
  return keys.map((key) => ({ key, value: sums.get(key) ?? 0 }));
}

/** Values added up by India month ("2026-10"), every month in `months` present. */
export const sumByIndiaMonth = (
  items: readonly { readonly at: number; readonly value: number }[],
  months: readonly string[],
): { month: string; value: number }[] =>
  sumByKey(items, months, indiaMonthOf).map(({ key, value }) => ({ month: key, value }));

/** Values added up by India date ("2026-10-28"), every day in `days` present. */
export const sumByIndiaDay = (
  items: readonly { readonly at: number; readonly value: number }[],
  days: readonly string[],
): { day: string; value: number }[] =>
  sumByKey(items, days, indiaDate).map(({ key, value }) => ({ day: key, value }));

/** Every date of a month ("2026-02" → "2026-02-01" … "2026-02-28"). */
export function daysOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/** Show every k-th label so about `most` fit under the chart. */
export const labelEvery = (n: number, most = 7): number => Math.max(1, Math.ceil(n / most));

/** The largest value and where it is (the first, on a tie); undefined for no values. */
export function peak<T extends { readonly value: number }>(points: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const p of points) if (!best || p.value > best.value) best = p;
  return best;
}

/**
 * The few words under a fold's title: "12 entries, latest 28 Oct". `latest` is a UTC time or an
 * India date; the year shows when it is not this year (`now`, UTC seconds).
 */
export function foldHint(
  n: number,
  noun: readonly [one: string, many: string] = ['entry', 'entries'],
  latest?: number | string,
  now?: number,
): string {
  if (n === 0) return `No ${noun[1]} yet`;
  const head = `${n.toLocaleString('en-IN')} ${n === 1 ? noun[0] : noun[1]}`;
  if (latest === undefined) return head;
  const date = typeof latest === 'number' ? indiaDate(latest) : latest.slice(0, 10);
  const thisYear = now === undefined ? undefined : indiaDate(now).slice(0, 4);
  return `${head}, latest ${dayLabel(date, thisYear !== undefined && date.slice(0, 4) !== thisYear)}`;
}

/** The latest of some UTC times (undefined for none). */
export const latestOf = (times: readonly number[]): number | undefined =>
  times.length ? Math.max(...times) : undefined;
