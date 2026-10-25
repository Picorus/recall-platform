// P1.8: people counts. The screen's AI chip counts the people facing the screen during each play
// and each minute. Pictures never leave the chip: only the number travels, signed with the play.
// Counts are an estimate. They are shown as a rounded range marked "approximate" and are never
// used for billing, make-ups, refunds, rider pay or promises (hard rule 7).

/** Settings for people counts (in the price book, versioned). */
export interface PeopleRules {
  /**
   * Most people one screen can plausibly face during one play. A higher count (a faulty chip) is
   * taken as this many, so one bad chip cannot blow up a report.
   */
  readonly perPlayMax: number;
  /** Reports show the count as a range this wide each side (1500 = ±15%). */
  readonly rangeBp: number;
}

export const DEFAULT_PEOPLE_RULES: PeopleRules = { perPlayMax: 150, rangeBp: 1_500 };

export function checkPeopleRules(r: PeopleRules): string[] {
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!whole(r.perPlayMax) || !whole(r.rangeBp)) return ['people settings must be whole numbers'];
  if (r.perPlayMax < 1 || r.rangeBp < 1 || r.rangeBp >= 10_000)
    return ['people: at least 1 per play; the range must be above 0% and under 100%'];
  return [];
}

/** People during a set of plays, each count limited to `perPlayMax`. */
export function peopleTotal(
  plays: readonly { readonly people: number }[],
  rules: PeopleRules = DEFAULT_PEOPLE_RULES,
): { readonly people: number; readonly capped: number } {
  let people = 0;
  let capped = 0;
  for (const p of plays) {
    if (p.people > rules.perPlayMax) capped += 1;
    people += Math.min(p.people, rules.perPlayMax);
  }
  return { people, capped };
}

/** What a report shows: a rounded range, never the exact count. */
export interface PeopleEstimate {
  readonly low: number;
  readonly high: number;
  readonly approximate: true;
  /** "2.0–2.8 lakh people (approximate)". */
  readonly text: string;
}

/** The size of the last place kept when rounding to two significant figures. */
function step(n: number): number {
  let s = 1;
  while (n >= s * 100) s *= 10;
  return s;
}

/**
 * The count as a range of ±`rangeBp`, rounded outwards to two significant figures (P1.8.3):
 * 2,40,000 people → 2.0–2.8 lakh. The exact count is never shown.
 */
export function peopleEstimate(
  people: number,
  rules: PeopleRules = DEFAULT_PEOPLE_RULES,
): PeopleEstimate {
  if (!Number.isSafeInteger(people) || people < 0) throw new RangeError(`Bad count: ${people}`);
  const lowRaw = Math.floor((people * (10_000 - rules.rangeBp)) / 10_000);
  const highRaw = Math.ceil((people * (10_000 + rules.rangeBp)) / 10_000);
  const low = Math.floor(lowRaw / step(lowRaw)) * step(lowRaw);
  const high = Math.ceil(highRaw / step(highRaw)) * step(highRaw);
  const text = high === 0 ? 'no people counted' : `${rangeText(low, high)} people (approximate)`;
  return { low, high, approximate: true, text };
}

/** 1,23,456 (Indian grouping). */
export function indianNumber(n: number): string {
  const s = String(n);
  if (s.length <= 3) return s;
  const head = s.slice(0, -3);
  return `${head.replace(/\B(?=(\d{2})+$)/g, ',')},${s.slice(-3)}`;
}

const UNITS = [
  { name: 'crore', size: 10_000_000 },
  { name: 'lakh', size: 100_000 },
] as const;

/**
 * The range in words. Both ends have two significant figures, so in lakh or crore they are exact
 * with at most one decimal (2.0 lakh, 12 lakh); below 1 lakh, whole numbers (8,500–12,000).
 */
function rangeText(low: number, high: number): string {
  const unit = UNITS.find((u) => low >= u.size);
  if (!unit) return `${indianNumber(low)}–${indianNumber(high)}`;
  const inUnit = (n: number) => {
    const x = n / unit.size;
    return x < 10 ? x.toFixed(1) : String(x);
  };
  return `${inUnit(low)}–${inUnit(high)} ${unit.name}`;
}
