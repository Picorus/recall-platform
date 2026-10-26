// P3.6: the admin "Prices and rules" page. A super admin changes the selling settings (band prices
// and hours, deal offers, the floor, minimums, the portal lead time, the ad deadline, the trial)
// as a new price book version; every other setting is carried over unchanged. Each change is
// checked by the price book rules and a few page rules, and shown in words (before → after).
import { checkPriceBook, PRICE_BOOK_V1, type PriceBand, type PriceBook } from './price-book.js';
import { INDIA_OFFSET_MINUTES } from './time.js';

export type BandName = PriceBand['name'];
export const BAND_NAMES: readonly BandName[] = ['Peak', 'Normal', 'Lite'];

/** What the page may change. Anything left out stays as it is. */
export interface PriceChange {
  /** Price of one bike-hour per band, paise before GST. */
  readonly prices?: Partial<Record<BandName, number>>;
  /** Which band each start hour (8 … 25) sells in. Hours left out keep their band. */
  readonly hourBands?: Readonly<Record<number, BandName>>;
  /** Deal offers: months → discount in basis points. Replaces the whole list. */
  readonly offersBp?: Readonly<Record<number, number>>;
  readonly repeatSpreadBp?: number;
  readonly floorPaisePerBikeHour?: number;
  readonly minBikesPerLine?: number;
  readonly minBookingPaise?: number;
  readonly portalLeadDays?: number;
  readonly adsDueDays?: number;
  readonly trialDays?: number;
  readonly trialBikeHours?: number;
}

/** The plain settings the page changes one for one. */
export const PLAIN_SETTINGS = [
  'repeatSpreadBp',
  'floorPaisePerBikeHour',
  'minBikesPerLine',
  'minBookingPaise',
  'portalLeadDays',
  'adsDueDays',
  'trialDays',
  'trialBikeHours',
] as const;

/** Start hours sold, India time (24 = midnight, 25 = 01:00). */
export const START_HOURS: readonly number[] = Array.from({ length: 18 }, (_, i) => i + 8);

/**
 * The next version: `current` (or, when no book was ever saved, the plan's book) with `change`
 * applied, starting at `validFrom`. Not checked here: see `checkPriceChange`.
 */
export function applyPriceChange(
  current: PriceBook | undefined,
  change: PriceChange,
  validFrom: string,
): PriceBook {
  const base = current ?? PRICE_BOOK_V1;
  const bandOfHour = new Map<number, BandName>();
  for (const b of base.bands) for (const h of b.startHours) bandOfHour.set(h, b.name);
  for (const [h, name] of Object.entries(change.hourBands ?? {})) bandOfHour.set(Number(h), name);
  const bands: PriceBand[] = BAND_NAMES.map((name) => ({
    name,
    startHours: [...bandOfHour]
      .filter(([, n]) => n === name)
      .map(([h]) => h)
      .sort((a, b) => a - b),
    paisePerBikeHour:
      change.prices?.[name] ??
      base.bands.find((b) => b.name === name)?.paisePerBikeHour ??
      base.floorPaisePerBikeHour,
  }));
  const plain: Partial<Record<(typeof PLAIN_SETTINGS)[number], number>> = {};
  for (const k of PLAIN_SETTINGS) if (change[k] !== undefined) plain[k] = change[k];
  return {
    ...base,
    ...plain,
    version: current ? current.version + 1 : 1,
    validFrom,
    bands,
    repeatOffersBp: change.offersBp ? { ...change.offersBp } : base.repeatOffersBp,
  };
}

/** Upper limits that keep a typing slip from going live (a super admin can still go to them). */
export const PRICE_LIMITS = {
  paisePerBikeHour: 1_00_000_00, // ₹1 lakh a bike-hour
  minBikesPerLine: 200,
  minBookingPaise: 1_00_00_000_00, // ₹1 crore
  days: 365,
  trialBikeHours: 10_000,
  offerMonths: 36,
} as const;

/** Everything wrong with the next version: the price book rules plus the page's own. */
export function checkPriceChange(next: PriceBook): string[] {
  const problems = [...checkPriceBook(next)];
  const L = PRICE_LIMITS;
  for (const b of next.bands)
    if (b.paisePerBikeHour > L.paisePerBikeHour)
      problems.push(`${b.name}: over ₹1 lakh a bike-hour`);
  if (next.floorPaisePerBikeHour < 1) problems.push('the floor must be above ₹0');
  if (next.minBikesPerLine > L.minBikesPerLine)
    problems.push(`minimum bikes must be 1 to ${L.minBikesPerLine}`);
  if (next.minBookingPaise > L.minBookingPaise) problems.push('minimum spend is over ₹1 crore');
  for (const [k, v] of [
    ['portal lead time', next.portalLeadDays],
    ['ad deadline', next.adsDueDays],
    ['trial length', next.trialDays],
  ] as const)
    if (v > L.days) problems.push(`${k} must be at most ${L.days} days`);
  if (next.trialDays < 1 || next.trialBikeHours < 1 || next.trialBikeHours > L.trialBikeHours)
    problems.push('a trial must be at least 1 day and 1 to 10,000 bike-hours');
  // A brand booking in the portal must have time to send its ads before they are due.
  if (next.adsDueDays >= next.portalLeadDays)
    problems.push('ads must be due fewer days ahead than the portal lead time');
  // Ads due on the first hour leave no time to review them.
  if (next.adsDueDays < 1) problems.push('ads must be due at least 1 day before the first hour');
  // With no spread at all, deals whose hours do not split evenly over the months are refused.
  if (next.repeatSpreadBp < 100 || next.repeatSpreadBp > 10_000)
    problems.push('the deal spread must be 1–100%');
  for (const [m, bp] of Object.entries(next.repeatOffersBp)) {
    if (Number(m) > L.offerMonths) problems.push(`offers are for 2 to ${L.offerMonths} months`);
    if (bp === 0) problems.push(`the ${m}-month offer must be above 0% (or remove it)`);
  }
  return [...new Set(problems)];
}

/** "₹300" or "₹225.50": a setting's money in words. */
export function rupeeText(paise: number): string {
  const whole = Math.floor(paise / 100);
  const rest = paise % 100;
  const s = String(whole);
  const head = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${head},${s.slice(-3)}` : s;
  return `₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** "8%" or "12.5%" from basis points. */
export function percentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const rest = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}

/** "08:00", "00:00" (24), "01:00" (25). */
export function hourText(startHour: number): string {
  return `${String(startHour % 24).padStart(2, '0')}:00`;
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const offersText = (o: Readonly<Record<number, number>>) => {
  const e = Object.entries(o).sort(([a], [b]) => Number(a) - Number(b));
  return e.length ? e.map(([m, bp]) => `${m} months ${percentText(bp)}`).join(', ') : 'none';
};

export interface SettingChange {
  readonly setting: string;
  readonly before: string;
  readonly after: string;
}

/** What `after` changes from `before` (nothing before: every setting is new), in words. */
export function describePriceChange(
  before: PriceBook | undefined,
  after: PriceBook,
): SettingChange[] {
  const rows: [string, (b: PriceBook) => string][] = [
    ...BAND_NAMES.flatMap((name): [string, (b: PriceBook) => string][] => {
      const band = (b: PriceBook) => b.bands.find((x) => x.name === name);
      return [
        [`${name} price a bike-hour`, (b) => rupeeText(band(b)?.paisePerBikeHour ?? 0)],
        [`${name} hours`, (b) => (band(b)?.startHours ?? []).map(hourText).join(' ') || 'none'],
      ];
    }),
    ['Deal offers', (b) => offersText(b.repeatOffersBp)],
    ['Deal months may differ by', (b) => percentText(b.repeatSpreadBp)],
    ['Floor a bike-hour', (b) => rupeeText(b.floorPaisePerBikeHour)],
    ['Minimum bikes a line', (b) => String(b.minBikesPerLine)],
    ['Minimum spend a booking', (b) => rupeeText(b.minBookingPaise)],
    ['Portal bookings start at least', (b) => `${days(b.portalLeadDays)} ahead`],
    ['Ads due', (b) => `${days(b.adsDueDays)} before the first hour`],
    ['Trial length', (b) => days(b.trialDays)],
    ['Trial bike-hours', (b) => String(b.trialBikeHours)],
  ];
  const out: SettingChange[] = [];
  for (const [setting, show] of rows) {
    const a = show(after);
    const b = before ? show(before) : '';
    if (a !== b) out.push({ setting, before: b, after: a });
  }
  return out;
}

/**
 * When the first version starts: 00:00 India time on the 1st of this month. Nothing can be sold
 * before a book exists, so starting it earlier changes no sale; but rider pay and other monthly
 * rules look up the book in force when the month starts, and must find one (review P3.6).
 */
export function firstVersionFrom(nowMs: number): string {
  const offset = INDIA_OFFSET_MINUTES * 60_000;
  const india = new Date(nowMs + offset);
  return new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), 1) - offset).toISOString();
}

/** What the Prices page shows of a book (not rider pay, cuts, taxes or the play rules). */
export function pageBook(b: PriceBook) {
  return {
    version: b.version,
    validFrom: b.validFrom,
    bands: b.bands,
    gstBp: b.gstBp,
    playsPerBikeHour: b.playsPerBikeHour,
    repeatOffersBp: b.repeatOffersBp,
    repeatOfferBands: b.repeatOfferBands,
    repeatSpreadBp: b.repeatSpreadBp,
    floorPaisePerBikeHour: b.floorPaisePerBikeHour,
    minBikesPerLine: b.minBikesPerLine,
    minBookingPaise: b.minBookingPaise,
    portalLeadDays: b.portalLeadDays,
    adsDueDays: b.adsDueDays,
    trialDays: b.trialDays,
    trialBikeHours: b.trialBikeHours,
  };
}
