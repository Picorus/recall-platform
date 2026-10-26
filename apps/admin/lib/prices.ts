// The Prices and rules page: reading what a person typed (rupees, percents, whole numbers) exactly,
// with no float on the way, and turning the form into only the settings that changed.

export type BandName = 'Peak' | 'Normal' | 'Lite';
export const BANDS: readonly BandName[] = ['Peak', 'Normal', 'Lite'];
export const START_HOURS: readonly number[] = Array.from({ length: 18 }, (_, i) => i + 8);

export interface Book {
  readonly version: number;
  readonly validFrom: string;
  readonly bands: readonly {
    name: BandName;
    startHours: readonly number[];
    paisePerBikeHour: number;
  }[];
  readonly gstBp: number;
  readonly repeatOffersBp: Readonly<Record<string, number>>;
  readonly repeatSpreadBp: number;
  readonly floorPaisePerBikeHour: number;
  readonly minBikesPerLine: number;
  readonly minBookingPaise: number;
  readonly portalLeadDays: number;
  readonly adsDueDays: number;
  readonly trialDays: number;
  readonly trialBikeHours: number;
  readonly playsPerBikeHour: number;
}

/** "300", "₹1,500.50" → paise; anything else is a problem in words. */
export function readRupees(text: string): number | { problem: string } {
  // Plain digits, Indian grouping (1,50,000) or Western grouping (150,000); never a stray comma.
  const m = /^₹?\s*(\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(
    text.trim(),
  );
  if (!m) return { problem: `"${text}" is not an amount in rupees` };
  const whole = Number((m[1] ?? '').replaceAll(',', ''));
  const paise = whole * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(paise)) return { problem: `"${text}" is too large` };
  return paise;
}

/** "8", "12.5%", "0.05" → basis points. */
export function readPercent(text: string): number | { problem: string } {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!m) return { problem: `"${text}" is not a percent` };
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function readWhole(text: string): number | { problem: string } {
  const t = text.trim();
  if (!/^\d{1,6}$/.test(t)) return { problem: `"${text}" is not a whole number` };
  return Number(t);
}

/** Paise as the page shows them in a box: "300", "220.50". */
export function rupeesBox(paise: number): string {
  const rest = paise % 100;
  return `${Math.floor(paise / 100)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** Basis points as the page shows them in a box: "8", "12.5". */
export function percentBox(bp: number): string {
  const rest = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return `${Math.floor(bp / 100)}${rest ? `.${rest}` : ''}`;
}

export function hourLabel(h: number): string {
  return `${String(h % 24).padStart(2, '0')}:00`;
}

/** The form as typed: every value a string, hours to bands, offers as rows. */
export interface PriceForm {
  readonly prices: Readonly<Record<BandName, string>>;
  readonly hourBands: Readonly<Record<number, BandName>>;
  readonly offers: readonly { months: string; percent: string }[];
  readonly spread: string;
  readonly floor: string;
  readonly minBikes: string;
  readonly minBooking: string;
  readonly leadDays: string;
  readonly adsDays: string;
  readonly trialDays: string;
  readonly trialBikeHours: string;
}

export function formOf(b: Book): PriceForm {
  const hourBands: Record<number, BandName> = {};
  for (const band of b.bands) for (const h of band.startHours) hourBands[h] = band.name;
  const price = (n: BandName) =>
    rupeesBox(b.bands.find((x) => x.name === n)?.paisePerBikeHour ?? 0);
  return {
    prices: { Peak: price('Peak'), Normal: price('Normal'), Lite: price('Lite') },
    hourBands,
    offers: Object.entries(b.repeatOffersBp)
      .sort(([a], [c]) => Number(a) - Number(c))
      .map(([months, bp]) => ({ months, percent: percentBox(bp) })),
    spread: percentBox(b.repeatSpreadBp),
    floor: rupeesBox(b.floorPaisePerBikeHour),
    minBikes: String(b.minBikesPerLine),
    minBooking: rupeesBox(b.minBookingPaise),
    leadDays: String(b.portalLeadDays),
    adsDays: String(b.adsDueDays),
    trialDays: String(b.trialDays),
    trialBikeHours: String(b.trialBikeHours),
  };
}

/**
 * The settings that differ from `b`, as the API takes them; or the first thing that cannot be read.
 * Offers are sent whole when any of them changed (the list replaces the old one).
 */
export function changeOf(
  b: Book,
  f: PriceForm,
): { change: Record<string, unknown> } | { problem: string } {
  const change: Record<string, unknown> = {};
  const prices: Record<string, number> = {};
  for (const n of BANDS) {
    const v = readRupees(f.prices[n]);
    if (typeof v !== 'number') return { problem: `${n} price: ${v.problem}` };
    if (v !== b.bands.find((x) => x.name === n)?.paisePerBikeHour) prices[n] = v;
  }
  if (Object.keys(prices).length) change.prices = prices;
  const was = formOf(b).hourBands;
  const moved: Record<string, BandName> = {};
  for (const h of START_HOURS) {
    const n = f.hourBands[h];
    if (n && n !== was[h]) moved[String(h)] = n;
  }
  if (Object.keys(moved).length) change.hourBands = moved;
  const offers: Record<string, number> = {};
  for (const o of f.offers) {
    if (o.months.trim() === '' && o.percent.trim() === '') continue;
    const m = readWhole(o.months);
    const p = readPercent(o.percent);
    if (typeof m !== 'number') return { problem: `Offer months: ${m.problem}` };
    if (typeof p !== 'number') return { problem: `Offer: ${p.problem}` };
    if (String(m) in offers) return { problem: `Two offers for ${m} months` };
    offers[String(m)] = p;
  }
  const sameOffers =
    Object.keys(offers).length === Object.keys(b.repeatOffersBp).length &&
    Object.entries(offers).every(([m, p]) => b.repeatOffersBp[m] === p);
  if (!sameOffers) change.offersBp = offers;
  const plain: [string, string, (t: string) => number | { problem: string }, string][] = [
    ['repeatSpreadBp', f.spread, readPercent, 'Deal spread'],
    ['floorPaisePerBikeHour', f.floor, readRupees, 'Floor'],
    ['minBikesPerLine', f.minBikes, readWhole, 'Minimum bikes'],
    ['minBookingPaise', f.minBooking, readRupees, 'Minimum spend'],
    ['portalLeadDays', f.leadDays, readWhole, 'Portal lead time'],
    ['adsDueDays', f.adsDays, readWhole, 'Ad deadline'],
    ['trialDays', f.trialDays, readWhole, 'Trial length'],
    ['trialBikeHours', f.trialBikeHours, readWhole, 'Trial bike-hours'],
  ];
  for (const [key, text, read, label] of plain) {
    const v = read(text);
    if (typeof v !== 'number') return { problem: `${label}: ${v.problem}` };
    if (v !== (b as unknown as Record<string, number>)[key]) change[key] = v;
  }
  return { change };
}
