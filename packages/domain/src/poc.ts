// P7.8: the POC package (Prateek, 29 Oct 2026). While the business switch is on POC, up to 40 brands
// (a setting) each pay a fixed fee a month (₹2.5 L + GST, a setting), before the month starts. Every
// bike, every business hour, anywhere in the POC zone, shares its 200 brand plays between them: 5 for
// each brand paid for that month, in turn, evenly spread (one every 12 minutes), and 40 RECALL spots
// (one after every five brand plays) that also take the slots of brands not there. Nothing is
// promised: no make-ups, no refunds. The screen builds every hour by itself from the month's plan
// (no network needed), and signs each play with the brand's POC month as its reference.
//
// Everything here is pure and the same on the screen (apps/player core: PocPlans, Spots.pocSpotAt),
// checked against the same shared cases (test-vectors/poc.json).
import { ACCOUNT_ID } from './brands.js';
import { inPayZone, type PayZone } from './pay-zone.js';
import {
  brandPlaysPerHour,
  DEFAULT_SPOT_RULES,
  hash32,
  isRecallSpot,
  type SpotChoice,
  type SpotRules,
} from './scheduler.js';
import { indiaHourStart } from './screen-plan.js';
import { businessDayOf } from './time.js';
import type { Entry, Posting } from './ledger.js';
import type { LatLng } from './geo.js';
import type { Place } from './areas.js';

// ---------------------------------------------------------------- the setting

/** The POC package's numbers: a setting (versioned; a super admin changes it in Settings). */
export interface PocRules {
  /** Most brands on the POC package in a month (40: 5 plays each of the 200 an hour). */
  readonly maxBrands: number;
  /** The fixed fee a month, before GST, in paise (₹2,50,000). */
  readonly feePaise: number;
  /** Most bikes with a screen fitted while the POC is on. */
  readonly maxBikes: number;
  /** Longest commitment a brand makes, in months (sales aims for all of them). */
  readonly maxMonths: number;
}

export const DEFAULT_POC_RULES: PocRules = {
  maxBrands: 40,
  feePaise: 25_000_000,
  maxBikes: 200,
  maxMonths: 3,
};

/** Checks a POC setting as typed or sent; throws why not (in plain words). */
export function checkPocRules(v: unknown, spots: SpotRules = DEFAULT_SPOT_RULES): PocRules {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new RangeError('POC package: not filled in');
  const o = v as Record<string, unknown>;
  const whole = (k: string, lo: number, hi: number, what: string): number => {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < lo || n > hi)
      throw new RangeError(`POC package, ${what}: a whole number ${lo} to ${hi}`);
    return n;
  };
  return {
    maxBrands: whole('maxBrands', 1, brandPlaysPerHour(spots), 'most brands'),
    // ₹1,000 to ₹1 crore a month, in paise.
    feePaise: whole('feePaise', 100_000, 1_000_000_000, 'fee a month in paise'),
    maxBikes: whole('maxBikes', 1, 20_000, 'most bikes'),
    maxMonths: whole('maxMonths', 1, 12, 'longest commitment in months'),
  };
}

/** Plays each brand gets on a bike in an hour: the hour's brand plays shared by the most brands. */
export const playsPerBrand = (r: PocRules, spots: SpotRules = DEFAULT_SPOT_RULES): number =>
  Math.floor(brandPlaysPerHour(spots) / r.maxBrands);

// ---------------------------------------------------------------- months and refs

const MONTH = /^(20\d{2})-(0[1-9]|1[0-2])$/;
const REF = /^poc\/([a-z0-9][a-z0-9-]{0,63})\/(20\d{2}-(?:0[1-9]|1[0-2]))$/;

export const isMonth = (m: string): boolean => MONTH.test(m);

/**
 * What a POC play names and the books file it under: "poc/<brand>/<YYYY-MM>" (the brand's POC
 * month). Plays, payment links, invoices and ledger entries all use it.
 */
export function pocRef(brandId: string, month: string): string {
  if (!ACCOUNT_ID.test(brandId)) throw new RangeError(`Not a brand id: ${brandId}`);
  if (!MONTH.test(month)) throw new RangeError('Month must be YYYY-MM');
  return `poc/${brandId}/${month}`;
}

/** The brand and month a POC reference names, or undefined when it is not one. */
export function parsePocRef(ref: string): { brandId: string; month: string } | undefined {
  const m = REF.exec(ref);
  return m?.[1] && m[2] ? { brandId: m[1], month: m[2] } : undefined;
}

/** A play reference that claims to be a POC month (well formed or not). */
export const isPocRef = (ref: string): boolean => ref.startsWith('poc/');

/** The month after "YYYY-MM". */
export function nextMonth(month: string): string {
  const m = MONTH.exec(month);
  if (!m) throw new RangeError('Month must be YYYY-MM');
  const y = Number(m[1]);
  const mm = Number(m[2]);
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
}

/** `n` months after "YYYY-MM" (0: the same month). */
export function addMonths(month: string, n: number): string {
  let m = month;
  for (let i = 0; i < n; i++) m = nextMonth(m);
  return m;
}

/** Days in a month "YYYY-MM". */
export function daysInMonth(month: string): number {
  const m = MONTH.exec(month);
  if (!m) throw new RangeError('Month must be YYYY-MM');
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
}

const at = (date: string, hour: number): number => {
  const t = indiaHourStart(date, hour);
  if (t === undefined) throw new RangeError(`Bad date ${date}`);
  return t;
};

/**
 * A POC month's business hours, UTC seconds [startsAt, endsAt): from 08:00 India time on the 1st
 * (when the POC is switched on, P7.7.7) to 02:00 on the 1st of the next month (the last day's
 * 23:00–02:00 belongs to it, hard rule 5).
 */
export function pocMonthWindow(month: string): { startsAt: number; endsAt: number } {
  return { startsAt: at(`${month}-01`, 8), endsAt: at(`${nextMonth(month)}-01`, 2) };
}

/** The month whose business day `t` is in ("2026-11" for 01:30 on 1 December), if any. */
export function businessMonthAt(t: number): string | undefined {
  return businessDayOf(new Date(t * 1000))?.slice(0, 7);
}

/** First second (UTC) of the India hour holding `t` (India hours start at :30 UTC). */
export const indiaHourOf = (t: number): number => Math.floor((t - 1800) / 3600) * 3600 + 1800;

// ---------------------------------------------------------------- money

/** The fee for one month with its GST, at the fee and GST rate in force when it is added. */
export function pocMonthMoney(
  feePaise: number,
  gstBp: number,
): { fee: number; gst: number; total: number } {
  if (!Number.isSafeInteger(feePaise) || feePaise <= 0) throw new RangeError('Fee: whole paise');
  if (!Number.isSafeInteger(gstBp) || gstBp < 0 || gstBp > 10_000) throw new RangeError('GST: bp');
  // To the nearest paisa, halves up (as price-book.ts bpOf; not imported: plays.ts imports this file).
  const gst = Math.floor((feePaise * gstBp + 5_000) / 10_000);
  return { fee: feePaise, gst, total: feePaise + gst };
}

/** The India dates of a month's business days that have ended by `now` (each ends 02:00 next day). */
export function pocDaysOver(month: string, now: number): string[] {
  const out: string[] = [];
  const days = daysInMonth(month);
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    if (at(date, 26) > now) break;
    out.push(date);
  }
  return out;
}

/**
 * What a POC month has earned once `daysOver` of its days have ended: the fee spread evenly over the
 * month's days, rounded down, so the last day completes it exactly (decision 29 Oct 2026: nothing is
 * promised, so the month is earned as it runs, day by day).
 */
export function pocEarnedAfter(feePaise: number, month: string, daysOver: number): number {
  const days = daysInMonth(month);
  const n = Math.max(0, Math.min(days, daysOver));
  return Math.floor((feePaise * n) / days);
}

const post = (
  account: Posting['account'],
  side: 'debit' | 'credit',
  paise: number,
  party?: string,
) =>
  paise === 0
    ? []
    : [
        {
          account,
          debit: side === 'debit' ? paise : 0,
          credit: side === 'credit' ? paise : 0,
          ...(party === undefined ? {} : { party }),
        },
      ];

/**
 * A brand pays a POC month in advance (fee + GST): held until the month runs; the GST is owed at
 * once (the tax invoice is issued with it). One entry per payment, ever.
 */
export function pocMonthPaid(p: {
  readonly ref: string;
  readonly brandId: string;
  readonly fee: number;
  readonly gst: number;
  readonly paymentId: string;
  readonly at: number;
}): Entry {
  return {
    entryId: `paid:${p.ref}:${p.paymentId}`,
    at: p.at,
    kind: 'poc-paid',
    ref: p.ref,
    memo: `POC month ${p.ref} paid in advance`,
    postings: [
      ...post('payment-clearing', 'debit', p.fee + p.gst, p.brandId),
      ...post('campaign-held', 'credit', p.fee, p.brandId),
      ...post('gst-payable', 'credit', p.gst),
    ],
  };
}

/**
 * One business day of a paid POC month earned: its share of the fee moves from held to revenue. The
 * day's share is what the month has earned after it less what it had earned after the day before,
 * so the days add up to the fee exactly. Undefined when the share is 0 (a tiny fee).
 */
export function pocDayEarned(d: {
  readonly ref: string;
  readonly brandId: string;
  readonly feePaise: number;
  readonly month: string;
  /** India date of the business day ("YYYY-MM-DD"), in the month. */
  readonly date: string;
  readonly at: number;
}): Entry | undefined {
  if (d.date.slice(0, 7) !== d.month) throw new RangeError(`${d.date} is not in ${d.month}`);
  const day = Number(d.date.slice(8, 10));
  const amount =
    pocEarnedAfter(d.feePaise, d.month, day) - pocEarnedAfter(d.feePaise, d.month, day - 1);
  if (amount === 0) return undefined;
  return {
    entryId: `poc-earned:${d.ref}:${d.date}`,
    at: d.at,
    kind: 'poc-earned',
    ref: d.ref,
    memo: `POC month ${d.ref}: ${d.date} ran`,
    postings: [
      ...post('campaign-held', 'debit', amount, d.brandId),
      ...post('revenue', 'credit', amount),
    ],
  };
}

// ---------------------------------------------------------------- the hour on a screen

/** A brand of a POC month as the screens need it: what its plays name, and its ads in turn. */
export interface PocBrandPlan {
  /** "poc/<brand>/<YYYY-MM>": what each of its plays names. */
  readonly ref: string;
  /** Its 2 to 5 approved ads, played in turn. */
  readonly ads: readonly string[];
}

/** A POC month as the screens get it: who shares every hour, where, and RECALL's own ads. */
export interface PocPlan {
  readonly month: string;
  /** Its business hours, UTC seconds [startsAt, endsAt) (earlier end when the POC is switched off). */
  readonly startsAt: number;
  readonly endsAt: number;
  /** Where it plays (the POC pay zone: 15 km of Hitech City). */
  readonly zone: PayZone;
  /** Brand slots in the rotation (the most brands, 40) and plays a slot gets an hour (5). */
  readonly slots: number;
  readonly perBrand: number;
  /** The brands paid for the month, in slot order (at most `slots`). */
  readonly brands: readonly PocBrandPlan[];
  /** RECALL's own ads: its 40 spots, and the slots of brands not there. */
  readonly recallAds: readonly string[];
}

/** Whether `t` (UTC seconds) is a business hour (08:00–02:00 India time). */
export const isBusinessHour = (t: number): boolean => businessDayOf(new Date(t * 1000)) !== null;

/** Whether a POC month's plan plays at `t`: inside its window and in a business hour. */
export const pocPlanCovers = (p: Pick<PocPlan, 'startsAt' | 'endsAt'>, t: number): boolean =>
  t >= p.startsAt && t < p.endsAt && isBusinessHour(t);

/**
 * Where a bike's rotation starts in an hour (0 … slots − 1): from its screen and the hour, so the
 * bikes on a street show different brands at once, and every bike still gives each slot its turns.
 */
export const pocOffset = (screenId: string, hourStartsAt: number, slots: number): number =>
  hash32(`${screenId}|${hourStartsAt}`) % Math.max(1, slots);

const nth = <T>(xs: readonly T[], i: number): T | undefined => xs[i % Math.max(1, xs.length)];

/**
 * The ad for spot `index` (0–239) of the hour starting `hourStartsAt` on screen `screenId`, under a
 * POC month's plan. Brand play k (0–199) goes to slot (k + offset) mod slots, in turns of one play
 * per slot: 5 turns of 40 slots, each brand once every 40 brand plays (12 minutes). A slot with no
 * brand, a turn past `perBrand`, and every sixth spot are RECALL's.
 */
export function pocSpotAt(
  plan: Pick<PocPlan, 'slots' | 'perBrand' | 'brands' | 'recallAds'>,
  screenId: string,
  hourStartsAt: number,
  index: number,
  rules: SpotRules = DEFAULT_SPOT_RULES,
): SpotChoice {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error(`spot ${index}: spots count from 0`);
  const recall = (): SpotChoice => ({ kind: 'recall', ad: nth(plan.recallAds, index) ?? '' });
  if (isRecallSpot(index, rules)) return recall();
  const group = rules.brandPlaysPerRecallSpot + 1;
  const k = Math.floor(index / group) * rules.brandPlaysPerRecallSpot + (index % group);
  const slots = Math.max(1, plan.slots);
  const turn = Math.floor(k / slots);
  const offset = pocOffset(screenId, hourStartsAt, slots);
  const slot = (k + offset) % slots;
  const b = plan.brands[slot];
  if (turn >= plan.perBrand || !b) return recall();
  const ad = nth(b.ads, turn + offset);
  return ad === undefined ? recall() : { kind: 'brand', lineId: b.ref, ad };
}

// ---------------------------------------------------------------- the message (down/poc)

const AD = /^[A-Za-z0-9_-]{1,64}$/;
const AREA_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** This month and the next (a third in case of a slow change of month). */
export const MAX_POC_PLANS = 3;
export const MAX_POC_SLOTS = 240;

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const exactly = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const whole = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
const adList = (x: unknown, min: number, max: number): x is string[] =>
  Array.isArray(x) &&
  x.length >= min &&
  x.length <= max &&
  x.every((a) => typeof a === 'string' && AD.test(a));
const coord = (x: unknown, limit: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limit;

function zoneProblem(z: unknown): string | undefined {
  if (!isObj(z)) return 'bad zone';
  if (z.kind === 'circle') {
    if (!exactly(z, ['kind', 'centre', 'radiusM'])) return 'bad zone';
    const c = z.centre;
    if (!isObj(c) || !exactly(c, ['lat', 'lng']) || !coord(c.lat, 90) || !coord(c.lng, 180))
      return 'bad zone centre';
    return whole(z.radiusM, 1, 1_000_000) ? undefined : 'bad zone radius';
  }
  if (z.kind === 'areas') {
    if (!exactly(z, ['kind', 'areaIds', 'withEdge'])) return 'bad zone';
    const ids = z.areaIds;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 200 ||
      !ids.every((a) => typeof a === 'string' && AREA_ID.test(a))
    )
      return 'bad zone areas';
    return typeof z.withEdge === 'boolean' ? undefined : 'bad zone';
  }
  return 'bad zone';
}

function planProblem(p: unknown): string | undefined {
  if (
    !isObj(p) ||
    !exactly(p, ['month', 'startsAt', 'endsAt', 'zone', 'slots', 'perBrand', 'brands', 'recallAds'])
  )
    return 'wrong plan fields';
  if (typeof p.month !== 'string' || !MONTH.test(p.month)) return 'bad month';
  const w = pocMonthWindow(p.month);
  // It starts at the month's first business hour; it may end early (the POC switched off).
  if (p.startsAt !== w.startsAt) return 'bad start time';
  if (!whole(p.endsAt, 1) || p.endsAt <= w.startsAt || p.endsAt > w.endsAt) return 'bad end time';
  const z = zoneProblem(p.zone);
  if (z) return z;
  if (!whole(p.slots, 1, MAX_POC_SLOTS)) return 'bad slots';
  if (!whole(p.perBrand, 1, MAX_POC_SLOTS)) return 'bad plays per brand';
  if (!adList(p.recallAds, 0, 100)) return 'bad RECALL ads';
  const brands = p.brands;
  if (!Array.isArray(brands) || brands.length > p.slots) return 'bad brands';
  const refs = new Set<string>();
  for (const b of brands) {
    if (!isObj(b) || !exactly(b, ['ref', 'ads'])) return 'wrong brand fields';
    const r = typeof b.ref === 'string' ? parsePocRef(b.ref) : undefined;
    if (!r || r.month !== p.month || refs.has(b.ref as string)) return 'bad brand ref';
    refs.add(b.ref as string);
    if (!adList(b.ads, 1, 5)) return 'bad brand ads';
  }
  return undefined;
}

/** The exact text of the POC plans message. Throws on what the screen would refuse. */
export function pocPlansText(plans: readonly PocPlan[], madeMs: number): string {
  const zone = (z: PayZone) =>
    z.kind === 'circle'
      ? { kind: 'circle', centre: { lat: z.centre.lat, lng: z.centre.lng }, radiusM: z.radiusM }
      : { kind: 'areas', areaIds: z.areaIds, withEdge: z.withEdge };
  const text = JSON.stringify({
    v: 1,
    made: madeMs,
    plans: plans.map((p) => ({
      month: p.month,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      zone: zone(p.zone),
      slots: p.slots,
      perBrand: p.perBrand,
      brands: p.brands.map((b) => ({ ref: b.ref, ads: b.ads })),
      recallAds: p.recallAds,
    })),
  });
  const back = parsePocPlans(text);
  if ('problem' in back) throw new Error(`POC plans: ${back.problem}`);
  return text;
}

/** Reads the POC plans message as the screen does (the newest message wins, whole). */
export function parsePocPlans(
  text: string,
): { readonly made: number; readonly plans: PocPlan[] } | { readonly problem: string } {
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return { problem: 'too big' };
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { problem: 'not a POC plans list' };
  }
  if (!isObj(x) || !exactly(x, ['v', 'made', 'plans'])) return { problem: 'not a POC plans list' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!whole(x.made, 1)) return { problem: 'bad list time' };
  if (!Array.isArray(x.plans) || x.plans.length > MAX_POC_PLANS) return { problem: 'bad list' };
  for (const p of x.plans) {
    const problem = planProblem(p);
    if (problem) return { problem };
  }
  const plans = x.plans as PocPlan[];
  if (new Set(plans.map((p) => p.month)).size !== plans.length)
    return { problem: 'a month listed twice' };
  return { made: x.made, plans };
}

// ---------------------------------------------------------------- counting (P1.5 for the POC)

/** What the cloud knows about a POC play's month when it judges it. */
export interface PocPlayContext {
  /** The POC was on when the play started (the business switch). */
  readonly on: boolean;
  /** The brand's POC month the play names, if it is one. */
  readonly month:
    | {
        readonly ref: string;
        /** Paid before it started (its link stops at the start: a later payment cannot happen). */
        readonly paid: boolean;
        /** The brand's POC ads in force then, approved in review. */
        readonly ads: readonly string[];
        readonly startsAt: number;
        readonly endsAt: number;
      }
    | undefined;
  /** The POC zone (the rider pay zone setting). */
  readonly zone: PayZone;
  /** This brand's plays already counted on this screen in the play's bike-hour. */
  readonly countedThisHour: number;
  /** Most that count a bike-hour (5). */
  readonly perBrand: number;
}

/**
 * Why a POC play (its own checks of time, accuracy and signature already passed) does not count, or
 * undefined when it counts for its month. `place` is where the cloud finds it among the areas.
 */
export function pocPlayProblem(
  p: {
    readonly slot: string;
    readonly ref: string;
    readonly adId: string;
    readonly startAt: number;
  },
  point: LatLng,
  place: Place,
  ctx: PocPlayContext,
): string | undefined {
  if (p.slot !== 'brand') return `${p.slot} spot`;
  const m = ctx.month;
  if (!m || m.ref !== p.ref) return 'not a POC month';
  if (!ctx.on) return 'the POC was not on';
  if (!m.paid) return 'POC month not paid';
  if (p.startAt < m.startsAt || p.startAt >= m.endsAt) return 'outside its month';
  if (!isBusinessHour(p.startAt)) return 'outside business hours';
  if (!m.ads.includes(p.adId)) return 'not one of its ads';
  if (!inPayZone(ctx.zone, point, place)) return 'outside the POC zone';
  if (ctx.countedThisHour >= ctx.perBrand) return `more than ${ctx.perBrand} this bike-hour`;
  return undefined;
}
