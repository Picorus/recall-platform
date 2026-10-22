// P1.4.7: proof that the ad scheduler delivers. Bikes ride for an hour; every 60 seconds the cloud
// assigns each bike inside an area to a booking line (or, with no network, every screen picks by
// itself from the hour plan). Each 15-second spot is counted for the line the bike carries.
//
// Bookings are sold from what the bikes really gave in that hour: a first pass with the same seed
// measures each area (different bikes and bike-hours, like the supply forecast, P1.3.7), and a share
// of that is sold. The second pass replays exactly the same rides with the scheduler on.
import {
  assign,
  brandPlaysPerHour,
  buildHourPlan,
  DEFAULT_SPOT_RULES,
  fallbackPick,
  isRecallSpot,
  launchAreas,
  locate,
  type AreaVersion,
  type BikeNow,
  type Carry,
  type HourPlan,
  type Progress,
} from '@recall/domain';
import { NORMAL_HABITS, newBike, tick, truthOf, type Bike, type BikeHabits } from './bike.js';
import { seeded } from './rng.js';
import { WEST_HYDERABAD, type RoadGrid } from './roads.js';

export interface ScheduleOptions {
  readonly bikes: number;
  readonly seed: number;
  /** 'live': the cloud assigns every 60 s. 'offline': no network all hour, screens pick by themselves. */
  readonly mode: 'live' | 'offline';
  /** Share of what each area really carried that is sold (0.8 = 80%). */
  readonly sellShare: number;
  /**
   * Seed of the day the sales are measured on. Default: the same rides (a perfect forecast);
   * another seed sells from a different day, as the real forecast does.
   */
  readonly forecastSeed?: number;
  /** Plays owed from earlier hours in each area, as a share of the plays sold there (make-ups). */
  readonly makeUpShare?: number;
  /** RECALL spots an aggregator wants in each area. */
  readonly aggregatorSpots?: number;
  /** First second of the hour (UTC). Default: Tue 24 Aug 2027, 18:00 India time. */
  readonly start?: number;
  readonly habits?: BikeHabits;
  readonly areas?: readonly AreaVersion[];
  readonly grid?: RoadGrid;
}

export interface LineResult {
  readonly lineId: string;
  readonly areaId: string;
  readonly bikes: number;
  readonly plays: number;
  readonly delivered: number;
  readonly differentBikes: number;
}

export interface ScheduleResult {
  readonly mode: ScheduleOptions['mode'];
  readonly bikes: number;
  /** What each area carried in the first pass: different bikes and whole bike-hours. */
  readonly areas: readonly { areaId: string; differentBikes: number; bikeHours: number }[];
  readonly lines: readonly LineResult[];
  /** Lines that got all their plays on at least as many different bikes as sold. */
  readonly linesMet: number;
  readonly playsSold: number;
  readonly playsDelivered: number;
  /** Make-up plays owed and delivered (in RECALL spots and on spare bikes), all areas together. */
  readonly makeUpsOwed: number;
  readonly makeUpsDelivered: number;
  /** RECALL spots given to the aggregator, and wanted. */
  readonly aggregatorPlayed: number;
  readonly aggregatorWanted: number;
  /** Brand spots played for RECALL's own ads while inside an area (spare capacity). */
  readonly spareSpots: number;
}

const HOUR = 3600;
/** A bike counts as "there" when it spent this long inside the area (as in the forecast). */
const MIN_SECONDS_INSIDE = 300;
const LINE_MAX_BIKES = 20;
const MIN_BIKES = 5;

/** Where each bike is, each second, for the hour (the same for both passes: same seed). */
function ride(
  o: ScheduleOptions,
  seed: number,
  visit: (second: number, positions: readonly (string | undefined)[]) => void,
): void {
  const grid = o.grid ?? WEST_HYDERABAD;
  const areas = o.areas ?? launchAreas();
  const habits = o.habits ?? NORMAL_HABITS;
  const start = startOf(o);
  const world = seeded(seed);
  // Start each bike a little before the hour so the fleet is spread over the roads.
  const warm = 600;
  let bikes: Bike[] = Array.from({ length: o.bikes }, (_, i) =>
    newBike(`sim-${i}`, grid, habits, world, start - warm),
  );
  const at: (string | undefined)[] = new Array<string | undefined>(o.bikes);
  for (let s = -warm; s < HOUR; s++) {
    const t = start + s;
    bikes = bikes.map((b) => tick(grid, b, habits, world, t));
    if (s < 0) continue;
    for (let i = 0; i < bikes.length; i++) {
      const b = bikes[i] as Bike;
      const truth = truthOf(grid, b, t);
      const p = truth.screenOn ? locate(truth.position, areas) : undefined;
      at[i] = p?.kind === 'inside' ? p.areaId : undefined;
    }
    visit(s, at);
  }
}

/** Splits `bikes` into booking lines of about equal size, at most 20 bikes each (never under 5). */
function linesOf(areaId: string, bikes: number): { lineId: string; bikes: number }[] {
  if (bikes < MIN_BIKES) return [];
  const n = Math.ceil(bikes / LINE_MAX_BIKES);
  return Array.from({ length: n }, (_, k) => ({
    lineId: `${areaId}#${k + 1}`,
    bikes: Math.floor(bikes / n) + (k < bikes % n ? 1 : 0),
  }));
}

const startOf = (o: ScheduleOptions) => o.start ?? Date.UTC(2027, 7, 24, 12, 30) / 1000;

export function simulateSchedule(o: ScheduleOptions): ScheduleResult {
  const rules = DEFAULT_SPOT_RULES;

  // Pass 1: what each area really carried.
  const secondsIn = new Map<string, Map<number, number>>();
  ride(o, o.forecastSeed ?? o.seed, (_s, at) => {
    at.forEach((areaId, i) => {
      if (areaId === undefined) return;
      const m = secondsIn.get(areaId) ?? new Map<number, number>();
      m.set(i, (m.get(i) ?? 0) + 1);
      secondsIn.set(areaId, m);
    });
  });
  const areaSupply = [...secondsIn.entries()]
    .map(([areaId, m]) => {
      const seconds = [...m.values()];
      return {
        areaId,
        differentBikes: seconds.filter((x) => x >= MIN_SECONDS_INSIDE).length,
        bikeHours: Math.floor(seconds.reduce((a, b) => a + b, 0) / HOUR),
      };
    })
    .sort((a, b) => (a.areaId < b.areaId ? -1 : 1));

  // Sell a share of it, as booking lines of 5 to 20 bikes.
  const start = startOf(o);
  const plans = new Map<string, HourPlan>();
  for (const a of areaSupply) {
    const sold = Math.floor(Math.min(a.differentBikes, a.bikeHours) * o.sellShare);
    const owed = Math.floor(sold * brandPlaysPerHour(rules) * (o.makeUpShare ?? 0));
    plans.set(
      a.areaId,
      buildHourPlan(
        {
          areaId: a.areaId,
          date: '2027-08-24',
          startHour: 18,
          startsAt: start,
          paid: linesOf(a.areaId, sold).map((l) => ({
            ...l,
            brandId: l.lineId,
            ads: [`${l.lineId}/1`, `${l.lineId}/2`],
          })),
          makeUps:
            owed > 0
              ? [{ lineId: `${a.areaId}#owed`, brandId: 'earlier', ads: ['owed/1'], plays: owed }]
              : [],
          trials: [],
          aggregator:
            (o.aggregatorSpots ?? 0) > 0
              ? [{ id: `${a.areaId}#agg`, ads: ['agg/1'], plays: o.aggregatorSpots ?? 0 }]
              : [],
          recallAds: ['recall/1'],
        },
        rules,
      ),
    );
  }

  // Pass 2: the hour itself, with the scheduler on.
  const progress = new Map<string, { plays: number; bikes: Set<number> }>();
  const spotPlays = new Map<string, number>();
  const carry: (Carry | undefined)[] = new Array<Carry | undefined>(o.bikes);
  // What each bike carried in each area this hour: a bike coming back carries the same again.
  const carryIn: (Map<string, Carry> | undefined)[] = new Array(o.bikes);
  const carriedIn: (Map<string, string[]> | undefined)[] = new Array(o.bikes);
  const wasIn: (string | undefined)[] = new Array<string | undefined>(o.bikes);
  let spareSpots = 0;
  ride(o, o.seed, (s, at) => {
    // A bike that enters an area carries what it had there before, else picks by itself until
    // the cloud's next answer.
    at.forEach((areaId, i) => {
      if (areaId === wasIn[i]) return;
      const plan = areaId === undefined ? undefined : plans.get(areaId);
      carry[i] =
        areaId === undefined || !plan
          ? undefined
          : (carryIn[i]?.get(areaId) ?? fallbackPick(plan, `sim-${i}`));
      wasIn[i] = areaId;
    });
    if (o.mode === 'live' && s % 60 === 0) {
      const inArea = new Map<string, number[]>();
      at.forEach((areaId, i) => {
        if (areaId === undefined) return;
        const list = inArea.get(areaId) ?? [];
        list.push(i);
        inArea.set(areaId, list);
      });
      for (const [areaId, idx] of inArea) {
        const plan = plans.get(areaId);
        if (!plan) continue;
        const bikes: BikeNow[] = idx.map((i) => ({
          screenId: `sim-${i}`,
          carrying: carry[i],
          carried: carriedIn[i]?.get(areaId) ?? [],
        }));
        const counted = new Map<string, Progress>();
        for (const l of plan.lines) {
          const p = progress.get(l.lineId);
          counted.set(l.lineId, { plays: p?.plays ?? 0, bikes: p?.bikes.size ?? 0 });
        }
        const answer = assign(plan, bikes, counted, spotPlays, start + s, rules);
        for (const i of idx) carry[i] = answer.get(`sim-${i}`);
      }
    }
    at.forEach((areaId, i) => {
      const c = carry[i];
      if (areaId === undefined || !c) return;
      const m = carryIn[i] ?? new Map<string, Carry>();
      m.set(areaId, c);
      carryIn[i] = m;
    });
    if (s % rules.spotSeconds !== 0) return;
    const spot = s / rules.spotSeconds;
    const recall = isRecallSpot(spot, rules);
    at.forEach((areaId, i) => {
      if (areaId === undefined) return;
      if (recall) {
        const id = carry[i]?.spotId;
        if (id !== undefined) spotPlays.set(id, (spotPlays.get(id) ?? 0) + 1);
        return;
      }
      const lineId = carry[i]?.lineId;
      if (lineId === undefined) {
        spareSpots += 1;
        return;
      }
      const p = progress.get(lineId) ?? { plays: 0, bikes: new Set<number>() };
      p.plays += 1;
      p.bikes.add(i);
      progress.set(lineId, p);
      const m = carriedIn[i] ?? new Map<string, string[]>();
      const list = m.get(areaId) ?? [];
      if (!list.includes(lineId)) m.set(areaId, [...list, lineId]);
      carriedIn[i] = m;
    });
  });

  const all = [...plans.values()];
  const lines: LineResult[] = all.flatMap((plan) =>
    plan.lines
      .filter((l) => l.kind === 'paid')
      .map((l) => ({
        lineId: l.lineId,
        areaId: plan.areaId,
        bikes: l.bikes,
        plays: l.plays,
        delivered: progress.get(l.lineId)?.plays ?? 0,
        differentBikes: progress.get(l.lineId)?.bikes.size ?? 0,
      })),
  );
  const demands = all.flatMap((p) => p.spotDemands);
  const owed = demands.filter((d) => d.kind === 'make-up');
  const agg = demands.filter((d) => d.kind === 'aggregator');
  return {
    mode: o.mode,
    bikes: o.bikes,
    areas: areaSupply,
    lines,
    linesMet: lines.filter((l) => l.delivered >= l.plays && l.differentBikes >= l.bikes).length,
    playsSold: lines.reduce((n, l) => n + l.plays, 0),
    playsDelivered: lines.reduce((n, l) => n + Math.min(l.plays, l.delivered), 0),
    makeUpsOwed: owed.reduce((n, d) => n + d.plays, 0),
    makeUpsDelivered: owed.reduce(
      (n, d) =>
        n + Math.min(d.plays, (spotPlays.get(d.id) ?? 0) + (progress.get(d.id)?.plays ?? 0)),
      0,
    ),
    aggregatorPlayed: agg.reduce((n, d) => n + Math.min(d.plays, spotPlays.get(d.id) ?? 0), 0),
    aggregatorWanted: agg.reduce((n, d) => n + d.plays, 0),
    spareSpots,
  };
}
