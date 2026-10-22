// P1.3: what a brand buys. The unit of sale is a bike-hour in an area-hour: an area, a business date
// and a start hour (08:00 to 01:00). A booking is a list of lines; each line is so many bikes in one
// area-hour. Prices come from the price book in force when the booking is made, and stay with it.
import type { AreaVersion } from './areas.js';
import { paise, type Paise } from './money.js';
import { bandOf, bikeHourPaise, bpOf, type PriceBook } from './price-book.js';
import { INDIA_OFFSET_MINUTES, parseUtcIso } from './time.js';

export interface BookingLine {
  readonly areaId: string;
  /** Business date, India time, "YYYY-MM-DD". */
  readonly date: string;
  /** Start hour, India time: 8 … 23, then 24 (midnight) and 25 (01:00) of the same business day. */
  readonly startHour: number;
  readonly bikes: number;
}

export type Channel = 'portal' | 'admin';

export interface BookingRequest {
  readonly lines: readonly BookingLine[];
  /** 1 for a one-off; 6 or 12 for a monthly repeat with its offer. */
  readonly repeatMonths: number;
  /** Brands in their own portal, or RECALL staff on a brand's behalf (no lead time; DECISIONS). */
  readonly channel: Channel;
}

export interface PricedLine extends BookingLine {
  readonly band: string;
  readonly paisePerBikeHour: number;
  readonly plays: number;
  readonly paise: Paise;
}

export interface Quote {
  readonly priceBookVersion: number;
  readonly lines: readonly PricedLine[];
  readonly bikeHours: number;
  readonly plays: number;
  readonly subtotal: Paise;
  readonly gst: Paise;
  readonly total: Paise;
  /** First hour starts (UTC seconds), and when ads are due. */
  readonly firstHourAt: number;
  readonly adsDueAt: number;
}

export type BookingProblem =
  | { readonly kind: 'no-lines' }
  | { readonly kind: 'bad-line'; readonly line: number; readonly detail: string }
  | { readonly kind: 'duplicate-line'; readonly line: number }
  | { readonly kind: 'area'; readonly line: number; readonly detail: string }
  | { readonly kind: 'too-few-bikes'; readonly line: number; readonly minimum: number }
  | { readonly kind: 'below-minimum'; readonly minimumPaise: number }
  | { readonly kind: 'too-soon'; readonly earliest: number }
  | { readonly kind: 'in-the-past' }
  | { readonly kind: 'no-offer'; readonly months: number };

export class BookingError extends Error {
  constructor(readonly problems: readonly BookingProblem[]) {
    super(`Booking refused: ${problems.map((p) => p.kind).join(', ')}`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400;

/** When a line's hour starts, as UTC seconds. */
export function lineStartsAt(line: Pick<BookingLine, 'date' | 'startHour'>): number {
  if (!DATE.test(line.date)) throw new RangeError(`Bad date: ${line.date}`);
  const [y, m, d] = line.date.split('-').map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d, line.startHour, 0) - INDIA_OFFSET_MINUTES * 60_000;
  const back = new Date(ms + INDIA_OFFSET_MINUTES * 60_000 - line.startHour * 3_600_000);
  if (back.toISOString().slice(0, 10) !== line.date)
    throw new RangeError(`No such date: ${line.date}`);
  return ms / 1000;
}

function lineKey(l: BookingLine): string {
  return `${l.areaId}|${l.date}|${l.startHour}`;
}

/**
 * Checks a booking and prices it. `now` is UTC seconds; `areas` are the areas in force (on and off,
 * drafts included) at the first hour. Throws BookingError with every problem found.
 */
export function quote(
  req: BookingRequest,
  book: PriceBook,
  areas: readonly AreaVersion[],
  now: number,
): Quote {
  const problems: BookingProblem[] = [];
  if (req.lines.length === 0) throw new BookingError([{ kind: 'no-lines' }]);
  if (req.repeatMonths !== 1 && book.repeatOffersBp[req.repeatMonths] === undefined) {
    problems.push({ kind: 'no-offer', months: req.repeatMonths });
  }
  const seen = new Set<string>();
  const priced: PricedLine[] = [];
  const starts: number[] = [];
  req.lines.forEach((l, i) => {
    let startsAt: number | undefined;
    try {
      if (!Number.isInteger(l.startHour) || l.startHour < 8 || l.startHour > 25)
        throw new RangeError('start hour must be 8–25');
      startsAt = lineStartsAt(l);
    } catch (e) {
      problems.push({ kind: 'bad-line', line: i, detail: (e as Error).message });
      return;
    }
    if (!Number.isSafeInteger(l.bikes) || l.bikes < 1) {
      problems.push({ kind: 'bad-line', line: i, detail: 'bikes must be a whole number' });
      return;
    }
    if (l.bikes < book.minBikesPerLine)
      problems.push({ kind: 'too-few-bikes', line: i, minimum: book.minBikesPerLine });
    if (seen.has(lineKey(l))) problems.push({ kind: 'duplicate-line', line: i });
    seen.add(lineKey(l));
    const area = areas.find((a) => a.areaId === l.areaId);
    if (!area) problems.push({ kind: 'area', line: i, detail: 'no such area' });
    else if (!area.active) problems.push({ kind: 'area', line: i, detail: 'area is off' });
    else if (area.draft) problems.push({ kind: 'area', line: i, detail: 'area is still a draft' });
    starts.push(startsAt);
    const each =
      req.repeatMonths === 1 || book.repeatOffersBp[req.repeatMonths] !== undefined
        ? bikeHourPaise(book, l.startHour, req.repeatMonths)
        : bandOf(book, l.startHour).paisePerBikeHour;
    priced.push({
      ...l,
      band: bandOf(book, l.startHour).name,
      paisePerBikeHour: each,
      plays: l.bikes * book.playsPerBikeHour,
      paise: paise(l.bikes * each),
    });
  });
  const firstHourAt = starts.length > 0 ? Math.min(...starts) : 0;
  if (starts.length > 0) {
    if (firstHourAt <= now) problems.push({ kind: 'in-the-past' });
    else if (req.channel === 'portal' && firstHourAt < now + book.portalLeadDays * DAY) {
      problems.push({ kind: 'too-soon', earliest: now + book.portalLeadDays * DAY });
    }
  }
  const subtotal = priced.reduce((sum, l) => sum + l.paise, 0);
  if (priced.length === req.lines.length && subtotal < book.minBookingPaise) {
    problems.push({ kind: 'below-minimum', minimumPaise: book.minBookingPaise });
  }
  if (problems.length > 0) throw new BookingError(problems);
  const gst = bpOf(subtotal, book.gstBp);
  return {
    priceBookVersion: book.version,
    lines: priced,
    bikeHours: priced.reduce((n, l) => n + l.bikes, 0),
    plays: priced.reduce((n, l) => n + l.plays, 0),
    subtotal: paise(subtotal),
    gst: paise(gst),
    total: paise(subtotal + gst),
    firstHourAt,
    adsDueAt: firstHourAt - book.adsDueDays * DAY,
  };
}

/** UTC ISO for a UTC-seconds instant (for picking the price book and areas in force). */
export function isoAt(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  if (Number.isNaN(parseUtcIso(iso))) throw new RangeError(`Bad instant ${seconds}`);
  return iso;
}
