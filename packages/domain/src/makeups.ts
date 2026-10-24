// P1.6: make-ups and refunds. If a line ends short, the missing plays are made up in the same area
// in the next 2 hours; still short, the same hour the next day; still short, the missing part is
// refunded (rulebook v5.4). Late uploads count until the day closes; extra plays are a bonus, never
// charged.
import { lineStartsAt } from './bookings.js';

/** Settings (in the price book, versioned). */
export interface MakeUpRules {
  /** Shortfall is worked out this long after an hour (or a make-up window) ends: late uploads. */
  readonly closeAfterSeconds: number;
  /** First make-up: this many hours straight after the line's hour, same area, same day. */
  readonly nextHours: number;
  /** The refund is decided this long after the last make-up ends (plays uploaded late still count). */
  readonly dayCloseSeconds: number;
}

export const DEFAULT_MAKE_UP_RULES: MakeUpRules = {
  closeAfterSeconds: 600,
  nextHours: 2,
  dayCloseSeconds: 24 * 3600,
};

/** Last start hour of the business day (01:00, written 25). */
const LAST_HOUR = 25;

export interface LineSlot {
  readonly lineId: string;
  readonly areaId: string;
  readonly date: string;
  readonly startHour: number;
}

/** One make-up: an area, a time window, and the plays owed. */
export interface MakeUpWindow {
  /** "<line id>#1" (next hours) or "<line id>#2" (next day). */
  readonly makeUpId: string;
  readonly stage: 1 | 2;
  readonly areaId: string;
  readonly date: string;
  readonly hours: readonly number[];
  /** UTC seconds: the window is [from, until). */
  readonly from: number;
  readonly until: number;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const windowOf = (
  line: LineSlot,
  stage: 1 | 2,
  date: string,
  hours: readonly number[],
): MakeUpWindow => ({
  makeUpId: `${line.lineId}#${stage}`,
  stage,
  areaId: line.areaId,
  date,
  hours,
  from: lineStartsAt({ date, startHour: hours[0] ?? 0 }),
  until: lineStartsAt({ date, startHour: hours[hours.length - 1] ?? 0 }) + 3600,
});

/**
 * Where a line's make-ups go: the next hours of the same business day (none after 01:00), then the
 * same hour the next day.
 */
export function makeUpWindows(
  line: LineSlot,
  rules: MakeUpRules = DEFAULT_MAKE_UP_RULES,
): { first: MakeUpWindow | undefined; second: MakeUpWindow } {
  const next = Array.from({ length: rules.nextHours }, (_, i) => line.startHour + 1 + i).filter(
    (h) => h <= LAST_HOUR,
  );
  return {
    first: next.length > 0 ? windowOf(line, 1, line.date, next) : undefined,
    second: windowOf(line, 2, addDays(line.date, 1), [line.startHour]),
  };
}

/** What has been decided for a line so far. */
export interface Settlement {
  /** Plays owed when each make-up was opened (absent = not decided yet). */
  readonly first?: { readonly owed: number } | 'not needed' | 'no window';
  readonly second?: { readonly owed: number } | 'not needed';
  readonly refund?: { readonly missing: number } | 'not needed';
}

/** Plays counted so far for the line and each of its make-ups. */
export interface Delivered {
  readonly line: number;
  readonly first: number;
  readonly second: number;
}

export type SettlementStep =
  | { readonly step: 'first'; readonly owed: number; readonly window: MakeUpWindow | undefined }
  | { readonly step: 'second'; readonly owed: number; readonly window: MakeUpWindow }
  | { readonly step: 'refund'; readonly missing: number };

/** Plays still missing: never below 0, never more than promised. Extra plays are a bonus. */
export const missingPlays = (promised: number, d: Delivered): number =>
  Math.max(0, Math.min(promised, promised - d.line - d.first - d.second));

/**
 * The next decision for a line that is due at `now`, or undefined. Each decision is made once and
 * recorded; asking again gives the next one. A line delivered in full needs nothing more.
 */
export function nextSettlementStep(
  line: LineSlot,
  promised: number,
  done: Settlement,
  delivered: Delivered,
  now: number,
  rules: MakeUpRules = DEFAULT_MAKE_UP_RULES,
): SettlementStep | undefined {
  const w = makeUpWindows(line, rules);
  const hourEnds = lineStartsAt(line) + 3600;
  const owed = missingPlays(promised, delivered);
  if (done.first === undefined) {
    if (now < hourEnds + rules.closeAfterSeconds) return undefined;
    return { step: 'first', owed, window: w.first };
  }
  // A line once delivered in full is still checked when the day closes: if plays were later found
  // fake (a stolen screen's key given up), what is missing is refunded.
  if (done.second === undefined && done.first !== 'not needed') {
    const after = (w.first?.until ?? hourEnds) + rules.closeAfterSeconds;
    if (now < after) return undefined;
    return { step: 'second', owed, window: w.second };
  }
  if (done.refund === undefined) {
    if (now < w.second.until + rules.dayCloseSeconds) return undefined;
    return { step: 'refund', missing: owed };
  }
  return undefined;
}

/** When the next decision for a line falls due (to skip lines with nothing due cheaply). */
export function nextDecisionAt(
  line: LineSlot,
  done: Settlement,
  rules: MakeUpRules = DEFAULT_MAKE_UP_RULES,
): number | undefined {
  const w = makeUpWindows(line, rules);
  const hourEnds = lineStartsAt(line) + 3600;
  if (done.first === undefined) return hourEnds + rules.closeAfterSeconds;
  if (done.second === undefined && done.first !== 'not needed')
    return (w.first?.until ?? hourEnds) + rules.closeAfterSeconds;
  if (done.refund === undefined) return w.second.until + rules.dayCloseSeconds;
  return undefined;
}

/**
 * Refund for missing plays (P1.6.4): missing ÷ promised × what was paid for the line, before GST,
 * rounded to the nearest paisa (halves up), never more than was paid. Exact whole-number maths.
 */
export function refundPaise(missing: number, promised: number, paidPaise: number): number {
  for (const [name, v] of [
    ['missing', missing],
    ['promised', promised],
    ['paid', paidPaise],
  ] as const)
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a whole number`);
  if (promised === 0 || missing === 0) return 0;
  const m = BigInt(Math.min(missing, promised));
  const out = (m * BigInt(paidPaise) * 2n + BigInt(promised)) / (2n * BigInt(promised));
  return Number(out);
}

/**
 * Each line's share of its booking's deal discount (paise), so a refund gives back what was really
 * paid for that line. Shares go to discounted lines in proportion to their price, rounded down, and
 * the paise left over go one each to the lines with the largest remainders (ties: the earlier
 * line), so the shares add up exactly to the discount: what the lines are paid adds up to the bill.
 */
export function discountShares(
  lines: readonly { readonly paise: number; readonly discounted: boolean }[],
  discount: number,
): number[] {
  const total = lines.reduce((n, l) => n + (l.discounted ? l.paise : 0), 0);
  if (discount === 0 || total === 0) return lines.map(() => 0);
  const D = BigInt(discount);
  const T = BigInt(total);
  const exact = lines.map((l) => (l.discounted ? D * BigInt(l.paise) : 0n));
  const shares = exact.map((x) => x / T);
  let left = D - shares.reduce((a, b) => a + b, 0n);
  const order = exact
    .map((x, i) => ({ i, rem: x % T, discounted: lines[i]?.discounted ?? false }))
    .filter((x) => x.discounted)
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    shares[i] = (shares[i] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares.map(Number);
}
