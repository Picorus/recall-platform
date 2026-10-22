// P1.4: the ad scheduler. Answers one question every minute: which booking line does each bike in
// each area carry right now, and what fills RECALL's spots on it?
//
// An hour on a screen is 240 spots of 15 seconds: after every 5 brand plays comes 1 RECALL spot, so
// 200 brand plays and 40 RECALL spots (P1.4.5). While a bike is inside an area it carries one booking
// line and plays only that brand's 2 to 5 ads in turn (P1.4.4). RECALL's spots are filled in this
// order (Prateek, 22 Oct 2026): make-ups owed to brands, then aggregator ads (free), then RECALL's
// own ads. Whole bikes go: paid lines → make-ups still short → free trials → RECALL's own ads (P1.4.6).
//
// Everything here is pure: the cloud runs `assign` every 60 seconds, and the screen runs
// `fallbackPick` and `spotAt` itself, so they must give the same answer everywhere.

/** How an hour on a screen is cut up. Settings, from the price book. */
export interface SpotRules {
  /** Length of one spot, seconds. */
  readonly spotSeconds: number;
  /** Brand plays before each RECALL spot (5 → 200 brand plays and 40 RECALL spots an hour). */
  readonly brandPlaysPerRecallSpot: number;
}

export const DEFAULT_SPOT_RULES: SpotRules = { spotSeconds: 15, brandPlaysPerRecallSpot: 5 };

/** Live assignment settings. */
export interface AssignRules {
  /**
   * Share of a bike's remaining plays counted on when it carries a line, basis points. Bikes leave
   * areas, so counting on all of them leaves lines short at the end of the hour; spare bikes top up.
   */
  readonly expectStayBp: number;
}

export const DEFAULT_ASSIGN_RULES: AssignRules = { expectStayBp: 9_000 };

export const HOUR_SECONDS = 3600;

export const spotsPerHour = (r: SpotRules): number => Math.floor(HOUR_SECONDS / r.spotSeconds);
export const recallSpotsPerHour = (r: SpotRules): number =>
  Math.floor(spotsPerHour(r) / (r.brandPlaysPerRecallSpot + 1));
export const brandPlaysPerHour = (r: SpotRules): number => spotsPerHour(r) - recallSpotsPerHour(r);

/** Spot `index` (0 = first spot of the hour) is a RECALL spot? */
export const isRecallSpot = (index: number, r: SpotRules): boolean =>
  index % (r.brandPlaysPerRecallSpot + 1) === r.brandPlaysPerRecallSpot;

// ---------------------------------------------------------------- P1.4.1 the hour plan

/** A booking line in an area-hour, as the screens need it. */
export interface PlanLine {
  readonly lineId: string;
  readonly brandId: string;
  /** 'paid' and 'trial' lines take whole bikes; make-ups are listed in `spotDemands` too. */
  readonly kind: 'paid' | 'make-up' | 'trial';
  /** The brand's 2 to 5 ads, played in turn. */
  readonly ads: readonly string[];
  /** Brand plays needed in this area-hour. */
  readonly plays: number;
  /** At least this many different bikes must carry it (a make-up has 0: no new promise). */
  readonly bikes: number;
}

/** Something that fills RECALL's spots. Make-ups first, then aggregator ads, in the plan's order. */
export interface SpotDemand {
  readonly id: string;
  readonly kind: 'make-up' | 'aggregator';
  readonly ads: readonly string[];
  /** Spots wanted in this area-hour. */
  readonly plays: number;
}

export interface HourPlan {
  readonly areaId: string;
  /** Business date and start hour (24 and 25 are 00:00 and 01:00 after the date). */
  readonly date: string;
  readonly startHour: number;
  /** First second of the hour, UTC. */
  readonly startsAt: number;
  /** Whole-bike lines: paid first, then make-ups, then trials. */
  readonly lines: readonly PlanLine[];
  /** RECALL's spots: make-ups first, then aggregator ads. */
  readonly spotDemands: readonly SpotDemand[];
  /** RECALL's own ads: whatever is left. */
  readonly recallAds: readonly string[];
}

export interface PlanInput {
  readonly areaId: string;
  readonly date: string;
  readonly startHour: number;
  readonly startsAt: number;
  /** Paid lines in this area-hour (ads approved): bikes sold. */
  readonly paid: readonly {
    readonly lineId: string;
    readonly brandId: string;
    readonly ads: readonly string[];
    readonly bikes: number;
  }[];
  /** Plays owed to brands that are due in this area-hour. */
  readonly makeUps: readonly {
    readonly lineId: string;
    readonly brandId: string;
    readonly ads: readonly string[];
    readonly plays: number;
  }[];
  readonly trials: PlanInput['paid'];
  /** Aggregator ads chosen by an admin for this area-hour, and the spots each wants. */
  readonly aggregator: readonly {
    readonly id: string;
    readonly ads: readonly string[];
    readonly plays: number;
  }[];
  readonly recallAds: readonly string[];
}

export class PlanError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('; '));
  }
}

/** Builds and checks the plan for one area-hour (made 2 hours ahead, sent to every screen). */
export function buildHourPlan(input: PlanInput, rules: SpotRules = DEFAULT_SPOT_RULES): HourPlan {
  const problems: string[] = [];
  const perBike = brandPlaysPerHour(rules);
  const ids = new Set<string>();
  const checkAds = (id: string, ads: readonly string[], min: number) => {
    if (ads.length < min || ads.length > 5) problems.push(`${id}: needs ${min} to 5 ads`);
  };
  const whole = (id: string, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) problems.push(`${id}: must be a whole number`);
  };
  const unique = (id: string) => {
    if (ids.has(id)) problems.push(`${id}: listed twice`);
    ids.add(id);
  };
  for (const l of [...input.paid, ...input.trials]) {
    unique(l.lineId);
    checkAds(l.lineId, l.ads, 2);
    whole(l.lineId, l.bikes);
  }
  for (const m of input.makeUps) {
    unique(m.lineId);
    checkAds(m.lineId, m.ads, 1);
    whole(m.lineId, m.plays);
  }
  for (const a of input.aggregator) {
    unique(a.id);
    checkAds(a.id, a.ads, 1);
    whole(a.id, a.plays);
  }
  if (input.recallAds.length === 0) problems.push('RECALL needs at least 1 ad of its own');
  if (problems.length > 0) throw new PlanError(problems);
  const line = (kind: 'paid' | 'trial') => (l: PlanInput['paid'][number]) => ({
    lineId: l.lineId,
    brandId: l.brandId,
    kind,
    ads: l.ads,
    plays: l.bikes * perBike,
    bikes: l.bikes,
  });
  return {
    areaId: input.areaId,
    date: input.date,
    startHour: input.startHour,
    startsAt: input.startsAt,
    lines: [
      ...input.paid.map(line('paid')),
      ...input.makeUps.map((m) => ({ ...m, kind: 'make-up' as const, bikes: 0 })),
      ...input.trials.map(line('trial')),
    ],
    spotDemands: [
      ...input.makeUps.map((m) => ({
        id: m.lineId,
        kind: 'make-up' as const,
        ads: m.ads,
        plays: m.plays,
      })),
      ...input.aggregator.map((a) => ({ ...a, kind: 'aggregator' as const })),
    ],
    recallAds: input.recallAds,
  };
}

// ---------------------------------------------------------------- P1.4.4–5 what a screen plays

export type SpotChoice =
  | { readonly kind: 'brand'; readonly lineId: string; readonly ad: string }
  | { readonly kind: 'make-up' | 'aggregator'; readonly id: string; readonly ad: string }
  | { readonly kind: 'recall'; readonly ad: string };

/** What a bike carries in an area-hour: its line, and what fills its RECALL spots. */
export interface Carry {
  /** Booking line for the brand spots; undefined = RECALL's own ads. */
  readonly lineId: string | undefined;
  /** Make-up or aggregator id for RECALL's spots; undefined = RECALL's own ads. */
  readonly spotId: string | undefined;
}

export const NOTHING: Carry = { lineId: undefined, spotId: undefined };

const nth = <T>(xs: readonly T[], i: number): T | undefined => xs[i % Math.max(1, xs.length)];

/** The ad for spot `index` of the hour on a bike carrying `carry` (ads take turns). */
export function spotAt(
  plan: HourPlan,
  carry: Carry,
  index: number,
  rules: SpotRules = DEFAULT_SPOT_RULES,
): SpotChoice {
  const recall = (): SpotChoice => ({
    kind: 'recall',
    ad: nth(plan.recallAds, index) ?? '',
  });
  const group = rules.brandPlaysPerRecallSpot + 1;
  if (isRecallSpot(index, rules)) {
    const d = plan.spotDemands.find((x) => x.id === carry.spotId);
    const ad = d && nth(d.ads, Math.floor(index / group));
    return d && ad !== undefined ? { kind: d.kind, id: d.id, ad } : recall();
  }
  const l = plan.lines.find((x) => x.lineId === carry.lineId);
  const brandIndex = Math.floor(index / group) * rules.brandPlaysPerRecallSpot + (index % group);
  const ad = l && nth(l.ads, brandIndex);
  return l && ad !== undefined ? { kind: 'brand', lineId: l.lineId, ad } : recall();
}

// ---------------------------------------------------------------- P1.4.2 live assignment

/** A bike inside the area now. */
export interface BikeNow {
  readonly screenId: string;
  /** What it carries now in this area-hour (undefined when it just came in). */
  readonly carrying?: Carry | undefined;
  /** Lines it has already carried in this area-hour (for the "different bikes" promise). */
  readonly carried: readonly string[];
}

/** What has been counted so far for a line or spot demand in this area-hour. */
export interface Progress {
  readonly plays: number;
  /** Different bikes that have carried it (lines only). */
  readonly bikes: number;
}

/** Plays a bike gives from now to the end of the hour: brand plays and RECALL spots. */
export function playsLeft(
  plan: HourPlan,
  now: number,
  rules: SpotRules = DEFAULT_SPOT_RULES,
): { brand: number; recall: number } {
  const total = spotsPerHour(rules);
  const done = Math.min(total, Math.max(0, Math.ceil((now - plan.startsAt) / rules.spotSeconds)));
  let recall = 0;
  for (let i = done; i < total; i++) if (isRecallSpot(i, rules)) recall += 1;
  return { brand: total - done - recall, recall };
}

const TIER: Readonly<Record<PlanLine['kind'], number>> = { paid: 0, 'make-up': 1, trial: 2 };

/**
 * Every minute, for one area: which line each bike inside carries, and what fills its RECALL
 * spots. A bike keeps what it carries while that is still wanted (no flicker for the brand). Each
 * other bike goes to the line with the biggest gap (need − counted − expected from bikes already
 * carrying it), paid lines first; a line still short of different bikes is offered bikes that have
 * not carried it yet. RECALL spots go to make-ups, then aggregator ads; anything left plays
 * RECALL's own ads.
 */
export function assign(
  plan: HourPlan,
  bikes: readonly BikeNow[],
  progress: ReadonlyMap<string, Progress>,
  now: number,
  rules: SpotRules = DEFAULT_SPOT_RULES,
  assignRules: AssignRules = DEFAULT_ASSIGN_RULES,
): Map<string, Carry> {
  const full = playsLeft(plan, now, rules);
  const stay = (n: number) => Math.floor((n * assignRules.expectStayBp) / 10_000);
  // Expected from one bike from now on; "nothing left" stays nothing.
  const left = { brand: stay(full.brand), recall: stay(full.recall), any: full.brand > 0 };
  const out = new Map<string, Carry>();
  const sorted = [...bikes].sort((a, b) => (a.screenId < b.screenId ? -1 : 1));

  // RECALL spots first: make-ups owed, then aggregator ads. A make-up counts its plays in RECALL
  // spots and on whole bikes together.
  const spotGap = new Map(
    plan.spotDemands.map((d) => [
      d.id,
      d.plays -
        (progress.get(`spot:${d.id}`)?.plays ?? 0) -
        (d.kind === 'make-up' ? (progress.get(d.id)?.plays ?? 0) : 0),
    ]),
  );
  const spotOf = new Map<string, string | undefined>();
  const takeSpot = (b: BikeNow, id: string) => {
    spotOf.set(b.screenId, id);
    spotGap.set(id, (spotGap.get(id) ?? 0) - left.recall);
  };
  const free: BikeNow[] = [];
  // Bikes already on a make-up keep it while it is owed.
  for (const b of sorted) {
    const id = b.carrying?.spotId;
    const d = plan.spotDemands.find((x) => x.id === id);
    if (d?.kind === 'make-up' && (spotGap.get(d.id) ?? 0) > 0) takeSpot(b, d.id);
    else free.push(b);
  }
  for (const b of free) {
    if (left.recall === 0) break;
    const open = plan.spotDemands.filter((x) => (spotGap.get(x.id) ?? 0) > 0);
    const first = open[0];
    if (!first) break;
    // Keep what it had if that is of the kind now being filled; otherwise the first in order.
    const had = open.find((x) => x.id === b.carrying?.spotId && x.kind === first.kind);
    takeSpot(b, (had ?? first).id);
  }

  // Whole bikes. A make-up's need is what its RECALL spots will not cover.
  const gap = new Map<string, number>();
  const short = new Map<string, number>();
  for (const l of plan.lines) {
    const p = progress.get(l.lineId) ?? { plays: 0, bikes: 0 };
    const viaSpots =
      l.kind === 'make-up'
        ? (progress.get(`spot:${l.lineId}`)?.plays ?? 0) +
          [...spotOf.values()].filter((x) => x === l.lineId).length * left.recall
        : 0;
    gap.set(l.lineId, l.plays - p.plays - viaSpots);
    short.set(l.lineId, l.bikes - p.bikes);
  }
  const take = (b: BikeNow, l: PlanLine) => {
    out.set(b.screenId, { lineId: l.lineId, spotId: spotOf.get(b.screenId) });
    gap.set(l.lineId, (gap.get(l.lineId) ?? 0) - left.brand);
    if (!b.carried.includes(l.lineId)) short.set(l.lineId, (short.get(l.lineId) ?? 0) - 1);
  };
  const byId = new Map(plan.lines.map((l) => [l.lineId, l]));
  const rest: BikeNow[] = [];
  for (const b of sorted) {
    const l = b.carrying?.lineId === undefined ? undefined : byId.get(b.carrying.lineId);
    // Kept until the line has all its plays counted.
    if (l && (progress.get(l.lineId)?.plays ?? 0) < l.plays) take(b, l);
    else rest.push(b);
  }
  // New bikes go first, so they reach the lines still short of different bikes.
  rest.sort((a, b) => a.carried.length - b.carried.length);
  for (const b of rest) {
    let best: PlanLine | undefined;
    let bestKey: readonly number[] = [];
    for (const l of plan.lines) {
      const g = gap.get(l.lineId) ?? 0;
      if (g <= 0 || !left.any) continue;
      const fresh = !b.carried.includes(l.lineId) && (short.get(l.lineId) ?? 0) > 0 ? 1 : 0;
      const key = [-TIER[l.kind], fresh, g];
      if (!best || compareKeys(key, bestKey) > 0) {
        best = l;
        bestKey = key;
      }
    }
    if (best) take(b, best);
    else out.set(b.screenId, { lineId: undefined, spotId: spotOf.get(b.screenId) });
  }
  return out;
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------- P1.4.3 offline fallback

/** FNV-1a, 32 bits, over the UTF-16 code units of `s` (the same in Kotlin: String.chars). */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Weighted rendezvous hashing: each choice gets a score from a hash of (screen, choice, hour), and
 * the screen takes the choice with the smallest −ln(u) / weight. Every screen picks independently,
 * yet over many screens each choice is picked in proportion to its weight. Ties go to the smaller id.
 */
export function rendezvous(
  screenId: string,
  hourKey: string,
  choices: readonly { readonly id: string; readonly weight: number }[],
): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of [...choices].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!(c.weight > 0)) continue;
    const u = (fnv1a32(`${screenId}|${c.id}|${hourKey}`) + 0.5) / 4_294_967_296;
    const score = -Math.log(u) / c.weight;
    if (score < bestScore) {
      best = c.id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * What a screen carries when no assignment has come from the cloud (P1.4.3). Paid lines, weighted
 * by the bikes sold; make-ups and trials only when there are no paid lines. RECALL spots: make-ups
 * and aggregator ads weighted by the spots they want.
 */
export function fallbackPick(plan: HourPlan, screenId: string): Carry {
  const hourKey = `${plan.areaId}|${plan.date}|${plan.startHour}`;
  const weighted = (kind: PlanLine['kind']) =>
    plan.lines
      .filter((l) => l.kind === kind)
      .map((l) => ({ id: l.lineId, weight: kind === 'make-up' ? l.plays : l.bikes }));
  const tiers = [weighted('paid'), weighted('make-up'), weighted('trial')];
  const lines = tiers.find((t) => t.some((c) => c.weight > 0)) ?? [];
  return {
    lineId: rendezvous(screenId, hourKey, lines),
    spotId: rendezvous(
      screenId,
      `${hourKey}|spot`,
      plan.spotDemands.map((d) => ({ id: d.id, weight: d.plays })),
    ),
  };
}
