// P1.3.2: prices, offers, minimums and deadlines. All of them are settings (hard rule 8): a super
// admin changes them in admin → Prices and rules, each change is a new version from a date, and a
// booking keeps the version it was sold on.
import { DEFAULT_CAPACITY_RULES, type CapacityRules } from './supply.js';
import { parseUtcIso } from './time.js';

/** A price band and the start hours it covers (India time; 24 = midnight, 25 = 01:00). */
export interface PriceBand {
  readonly name: 'Peak' | 'Normal' | 'Lite';
  readonly startHours: readonly number[];
  /** Price of one bike-hour, in paise, before GST. */
  readonly paisePerBikeHour: number;
}

export interface PriceBook {
  readonly version: number;
  /** When this version starts to apply (UTC ISO). */
  readonly validFrom: string;
  readonly bands: readonly PriceBand[];
  /** One bike-hour = this many plays of the brand's ads (P1.3.1). */
  readonly playsPerBikeHour: number;
  /** GST in basis points (1800 = 18%). */
  readonly gstBp: number;
  readonly minBikesPerLine: number;
  /** Minimum spend per booking, paise, before GST. */
  readonly minBookingPaise: number;
  /** Offers for 6- and 12-month deals: months → discount on the bill, in basis points. */
  readonly repeatOffersBp: Readonly<Record<number, number>>;
  /** Bands the deal discount applies to (not Lite: Prateek, 22 Oct 2026). */
  readonly repeatOfferBands: readonly PriceBand['name'][];
  /** Each month of a deal must hold its share of the hours within this, in basis points (2000 = ±20%). */
  readonly repeatSpreadBp: number;
  /** No bike-hour is ever sold below this, paise (offers and discounts included). */
  readonly floorPaisePerBikeHour: number;
  /** Brands booking in their own portal must start at least this many days ahead (admins: any time). */
  readonly portalLeadDays: number;
  /** Ads are due this many days before the first hour. */
  readonly adsDueDays: number;
  /** Free trial: one per business, this long, this many bike-hours at most, one area. */
  readonly trialDays: number;
  readonly trialBikeHours: number;
  /** How many bikes an area-hour can be sold for (POC: manual limits only; after: forecast). */
  readonly capacity: CapacityRules;
}

/** The book in force from 22 Oct 2026: rulebook v5.4 and Prateek's decisions of 21–22 Oct. */
export const PRICE_BOOK_V1: PriceBook = {
  version: 1,
  validFrom: '2026-10-22T00:00:00.000Z',
  bands: [
    { name: 'Peak', startHours: [8, 9, 10, 17, 18, 19, 20, 21, 22], paisePerBikeHour: 30_000 },
    { name: 'Normal', startHours: [11, 12, 13, 14, 15, 16], paisePerBikeHour: 25_000 },
    { name: 'Lite', startHours: [23, 24, 25], paisePerBikeHour: 22_000 },
  ],
  playsPerBikeHour: 200,
  gstBp: 1_800,
  minBikesPerLine: 5,
  minBookingPaise: 1_500_000,
  repeatOffersBp: { 6: 800, 12: 1_200 },
  repeatOfferBands: ['Peak', 'Normal'],
  repeatSpreadBp: 2_000,
  floorPaisePerBikeHour: 22_000,
  portalLeadDays: 15,
  adsDueDays: 7,
  trialDays: 7,
  trialBikeHours: 20,
  capacity: DEFAULT_CAPACITY_RULES,
};

export type PriceBookProblem = string;

/** Checks a price book before it is saved. Returns what is wrong; empty when it can be saved. */
export function checkPriceBook(b: PriceBook): PriceBookProblem[] {
  const problems: PriceBookProblem[] = [];
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!Number.isSafeInteger(b.version) || b.version < 1) problems.push('version must be 1 or more');
  if (Number.isNaN(parseUtcIso(b.validFrom))) problems.push('validFrom must be a UTC time');
  const hours = b.bands.flatMap((x) => x.startHours);
  const expected = Array.from({ length: 18 }, (_, i) => i + 8); // 08:00 … 01:00 starts
  if (hours.length !== expected.length || expected.some((h) => !hours.includes(h))) {
    problems.push('every start hour from 08:00 to 01:00 must be in exactly one band');
  }
  for (const band of b.bands) {
    if (!whole(band.paisePerBikeHour)) problems.push(`${band.name}: price must be whole paise`);
    if (band.paisePerBikeHour < b.floorPaisePerBikeHour)
      problems.push(`${band.name}: below the floor`);
  }
  for (const [months, bp] of Object.entries(b.repeatOffersBp)) {
    if (!Number.isSafeInteger(Number(months)) || Number(months) < 2)
      problems.push('offer months must be 2 or more');
    if (!Number.isSafeInteger(bp) || bp < 0 || bp >= 10_000)
      problems.push('offer must be 0–99.99%');
  }
  for (const [name, v] of [
    ['playsPerBikeHour', b.playsPerBikeHour],
    ['gstBp', b.gstBp],
    ['minBikesPerLine', b.minBikesPerLine],
    ['minBookingPaise', b.minBookingPaise],
    ['floorPaisePerBikeHour', b.floorPaisePerBikeHour],
    ['portalLeadDays', b.portalLeadDays],
    ['adsDueDays', b.adsDueDays],
    ['trialDays', b.trialDays],
    ['trialBikeHours', b.trialBikeHours],
    ['repeatSpreadBp', b.repeatSpreadBp],
  ] as const) {
    if (!whole(v)) problems.push(`${name} must be a whole number`);
  }
  if (b.playsPerBikeHour < 1 || b.minBikesPerLine < 1)
    problems.push('plays and bikes must be at least 1');
  const c = b.capacity;
  if (c.mode !== 'poc' && c.mode !== 'forecast')
    problems.push('capacity mode must be poc or forecast');
  const counts = [
    c.lookbackWeeks,
    c.levelWeeks,
    c.minWeeks,
    c.minSecondsInside,
    c.nearbyMeters,
    c.makeUpMarginBp,
  ];
  if (!counts.every(whole)) problems.push('capacity settings must be whole numbers');
  if (c.levelWeeks < 1 || c.levelWeeks > c.lookbackWeeks || c.makeUpMarginBp >= 10_000) {
    problems.push('capacity: level weeks must be 1 to lookback weeks, margin under 100%');
  }
  return problems;
}

/** The price book in force at `instant`. */
export function priceBookAt(books: readonly PriceBook[], instant: string): PriceBook | undefined {
  const at = parseUtcIso(instant);
  if (Number.isNaN(at)) throw new RangeError(`Not a UTC time: ${instant}`);
  let found: PriceBook | undefined;
  for (const b of books) {
    if (parseUtcIso(b.validFrom) <= at && (!found || b.version > found.version)) found = b;
  }
  return found;
}

export function bandOf(book: PriceBook, startHour: number): PriceBand {
  const band = book.bands.find((b) => b.startHours.includes(startHour));
  if (!band) throw new RangeError(`No band sells start hour ${startHour}`);
  return band;
}

/** `paise` less `bp` basis points, to the nearest paisa (halves up). Whole numbers only. */
export function lessBp(paise: number, bp: number): number {
  return Math.floor((paise * (10_000 - bp) + 5_000) / 10_000);
}

/** `bp` basis points of `paise`, to the nearest paisa (halves up). */
export function bpOf(paise: number, bp: number): number {
  return Math.floor((paise * bp + 5_000) / 10_000);
}

/** List price of one bike-hour at this start hour (deal discounts go on the bill, not the hour). */
export function bikeHourPaise(book: PriceBook, startHour: number): number {
  return bandOf(book, startHour).paisePerBikeHour;
}
