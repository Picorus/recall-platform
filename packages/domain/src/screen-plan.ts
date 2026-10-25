// P2.6: what the cloud tells a screen so it can choose what to play by itself (the local scheduler):
//   down/areas   the city's area shapes in force now (the whole list; the newest list wins)
//   down/plan    hour plans for the next 2 hours, every area of the city (P1.4.1; per area-hour the
//                highest revision wins: a make-up opened re-sends it, P1.6.2)
//   down/assign  the cloud's live pick for this screen in one area-hour (P1.4.2; per area-hour the
//                newest wins). Without one, the screen picks by itself (fallbackPick, P1.4.3).
// The Kotlin player reads the same text (shared cases in test-vectors/screen-plan.json). Each builder
// refuses what the screen would refuse, so the cloud can never send a message the screen drops.
import type { AreaVersion } from './areas.js';
import type { Carry, HourPlan } from './scheduler.js';

const AREA_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Booking lines, make-ups, aggregator ads and ads. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** India is UTC+5:30, with no summer time: every hour starts at :30 UTC. */
const IST_OFFSET = 19_800;
const HOUR = 3600;
const startsOnIndiaHour = (startsAt: number) => startsAt % HOUR === 1800;

/** The first second (UTC) of `startHour` on the business date `date` (24 and 25: after midnight). */
export function indiaHourStart(date: string, startHour: number): number | undefined {
  if (!DATE.test(date)) return undefined;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const midnight = Date.UTC(y, m - 1, d);
  const back = new Date(midnight);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    return undefined;
  return midnight / 1000 - IST_OFFSET + startHour * HOUR;
}

export const MAX_AREAS = 200;
export const MAX_CORNERS = 500;
export const MAX_PLANS = 1000;
export const MAX_LINES = 100;
export const MAX_EDGE = 2000;
/** Largest message the screen reads (the broker's own packet limit is 1 MB). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_VERSION = 2 ** 31 - 1;
const TOO_BIG = Symbol('too big');

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const hasExactly = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const isWhole = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
const isId = (x: unknown): x is string => typeof x === 'string' && ID.test(x);
const isIdList = (x: unknown, min: number, max: number): x is string[] =>
  Array.isArray(x) && x.length >= min && x.length <= max && x.every(isId);
const isCoord = (x: unknown, limit: number): x is number =>
  typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= limit;

/** The message as JSON; TOO_BIG past the size limit; undefined when it is not JSON. */
function readJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) return TOO_BIG;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A list of objects under `key`, each checked; the first problem, or the items. */
function each<T>(
  x: unknown,
  max: number,
  check: (o: unknown) => string | undefined,
): { items: T[] } | { problem: string } {
  if (!Array.isArray(x) || x.length > max) return { problem: 'bad list' };
  for (const o of x) {
    const problem = check(o);
    if (problem) return { problem };
  }
  return { items: x as T[] };
}

// ---------------------------------------------------------------- areas

/** An area as the screen needs it: the version in force now, its shape and edge zone. */
export type ScreenArea = Pick<AreaVersion, 'areaId' | 'version' | 'ring' | 'edgeMeters' | 'active'>;

function areaProblem(a: unknown): string | undefined {
  if (!isPlainObject(a) || !hasExactly(a, ['areaId', 'version', 'edgeMeters', 'active', 'ring']))
    return 'wrong area fields';
  if (typeof a.areaId !== 'string' || !AREA_ID.test(a.areaId)) return 'bad area id';
  if (!isWhole(a.version, 1, MAX_VERSION)) return 'bad area version';
  if (!isWhole(a.edgeMeters, 0, MAX_EDGE)) return 'bad edge zone';
  if (typeof a.active !== 'boolean') return 'bad on/off';
  const ring = a.ring;
  if (!Array.isArray(ring) || ring.length < 3 || ring.length > MAX_CORNERS) return 'bad shape';
  for (const p of ring)
    if (!Array.isArray(p) || p.length !== 2 || !isCoord(p[0], 90) || !isCoord(p[1], 180))
      return 'bad corner';
  return undefined;
}

/** The exact text of the areas message: corners as [lat, lng]. Throws on what the screen refuses. */
export function areasText(areas: readonly ScreenArea[], madeMs: number): string {
  const wire = areas.map((a) => ({
    areaId: a.areaId,
    version: a.version,
    edgeMeters: a.edgeMeters,
    active: a.active,
    ring: a.ring.map((p) => [p.lat, p.lng]),
  }));
  const text = JSON.stringify({ v: 1, made: madeMs, areas: wire });
  const back = parseAreas(text);
  if ('problem' in back) throw new Error(`areas: ${back.problem}`);
  return text;
}

export function parseAreas(
  text: string,
): { readonly made: number; readonly areas: ScreenArea[] } | { readonly problem: string } {
  const x = readJson(text);
  if (x === TOO_BIG) return { problem: 'too big' };
  if (!isPlainObject(x) || !hasExactly(x, ['v', 'made', 'areas']))
    return { problem: 'not an areas list' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!isWhole(x.made, 1)) return { problem: 'bad list time' };
  const list = each<{
    areaId: string;
    version: number;
    edgeMeters: number;
    active: boolean;
    ring: [number, number][];
  }>(x.areas, MAX_AREAS, areaProblem);
  if ('problem' in list) return list;
  if (new Set(list.items.map((a) => a.areaId)).size !== list.items.length)
    return { problem: 'an area listed twice' };
  return {
    made: x.made,
    areas: list.items.map((a) => ({
      areaId: a.areaId,
      version: a.version,
      edgeMeters: a.edgeMeters,
      active: a.active,
      ring: a.ring.map(([lat, lng]) => ({ lat, lng })),
    })),
  };
}

// ---------------------------------------------------------------- plans

/** An hour plan as screens get it: all the cloud's plan but the brand ids (not needed to play). */
export type ScreenPlan = Omit<HourPlan, 'lines'> & {
  readonly lines: readonly Omit<HourPlan['lines'][number], 'brandId'>[];
};

const LINE_KINDS = ['paid', 'make-up', 'trial'];
const DEMAND_KINDS = ['make-up', 'aggregator'];

function planProblem(p: unknown): string | undefined {
  if (
    !isPlainObject(p) ||
    !hasExactly(p, [
      'areaId',
      'date',
      'startHour',
      'startsAt',
      'revision',
      'lines',
      'spotDemands',
      'recallAds',
    ])
  )
    return 'wrong plan fields';
  if (typeof p.areaId !== 'string' || !AREA_ID.test(p.areaId)) return 'bad area id';
  if (typeof p.date !== 'string' || !DATE.test(p.date)) return 'bad date';
  if (!isWhole(p.startHour, 0, 25)) return 'bad start hour';
  // Exactly the hour its date and start hour name (the screen's own pick is keyed on both).
  if (!isWhole(p.startsAt, 1) || p.startsAt !== indiaHourStart(p.date, p.startHour))
    return 'bad start time';
  if (!isWhole(p.revision, 1)) return 'bad revision';
  if (!isIdList(p.recallAds, 0, MAX_LINES)) return 'bad RECALL ads';
  const ids = new Set<string>();
  const lines = each(p.lines, MAX_LINES, (l) => {
    if (!isPlainObject(l) || !hasExactly(l, ['lineId', 'kind', 'ads', 'plays', 'bikes']))
      return 'wrong line fields';
    if (!isId(l.lineId) || ids.has(l.lineId)) return 'bad line id';
    ids.add(l.lineId);
    if (typeof l.kind !== 'string' || !LINE_KINDS.includes(l.kind)) return 'bad line kind';
    if (!isIdList(l.ads, 1, 5)) return 'bad line ads';
    if (!isWhole(l.plays, 0) || !isWhole(l.bikes, 0)) return 'bad line numbers';
    return undefined;
  });
  if ('problem' in lines) return lines.problem;
  const demandIds = new Set<string>();
  const demands = each(p.spotDemands, MAX_LINES, (d) => {
    if (!isPlainObject(d) || !hasExactly(d, ['id', 'kind', 'ads', 'plays']))
      return 'wrong spot fields';
    if (!isId(d.id) || demandIds.has(d.id)) return 'bad spot id';
    demandIds.add(d.id);
    if (typeof d.kind !== 'string' || !DEMAND_KINDS.includes(d.kind)) return 'bad spot kind';
    if (!isIdList(d.ads, 1, 5)) return 'bad spot ads';
    if (!isWhole(d.plays, 0)) return 'bad spot plays';
    return undefined;
  });
  return 'problem' in demands ? demands.problem : undefined;
}

/** The exact text of the plans message. Brand ids are left out. Throws on what the screen refuses. */
export function plansText(plans: readonly HourPlan[], madeMs: number): string {
  const wire = plans.map((p) => ({
    areaId: p.areaId,
    date: p.date,
    startHour: p.startHour,
    startsAt: p.startsAt,
    revision: p.revision,
    lines: p.lines.map((l) => ({
      lineId: l.lineId,
      kind: l.kind,
      ads: l.ads,
      plays: l.plays,
      bikes: l.bikes,
    })),
    spotDemands: p.spotDemands.map((d) => ({ id: d.id, kind: d.kind, ads: d.ads, plays: d.plays })),
    recallAds: p.recallAds,
  }));
  const text = JSON.stringify({ v: 1, made: madeMs, plans: wire });
  const back = parsePlans(text);
  if ('problem' in back) throw new Error(`plans: ${back.problem}`);
  return text;
}

export function parsePlans(
  text: string,
): { readonly made: number; readonly plans: ScreenPlan[] } | { readonly problem: string } {
  const x = readJson(text);
  if (x === TOO_BIG) return { problem: 'too big' };
  if (!isPlainObject(x) || !hasExactly(x, ['v', 'made', 'plans']))
    return { problem: 'not a plans list' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!isWhole(x.made, 1)) return { problem: 'bad list time' };
  const list = each<ScreenPlan>(x.plans, MAX_PLANS, planProblem);
  if ('problem' in list) return list;
  const keys = new Set(list.items.map((p) => `${p.areaId}|${p.startsAt}`));
  if (keys.size !== list.items.length) return { problem: 'an area-hour listed twice' };
  return { made: x.made, plans: list.items };
}

// ---------------------------------------------------------------- the live assignment

/** The cloud's pick for one screen in one area-hour (undefined ids: RECALL's own ads). */
export interface ScreenAssignment {
  readonly areaId: string;
  readonly startsAt: number;
  readonly carry: Carry;
}

export function assignText(a: ScreenAssignment, madeMs: number): string {
  const text = JSON.stringify({
    v: 1,
    made: madeMs,
    areaId: a.areaId,
    startsAt: a.startsAt,
    lineId: a.carry.lineId ?? null,
    spotId: a.carry.spotId ?? null,
  });
  const back = parseAssign(text);
  if ('problem' in back) throw new Error(`assignment: ${back.problem}`);
  return text;
}

export function parseAssign(
  text: string,
): ({ readonly made: number } & ScreenAssignment) | { readonly problem: string } {
  const x = readJson(text);
  if (x === TOO_BIG) return { problem: 'too big' };
  if (!isPlainObject(x) || !hasExactly(x, ['v', 'made', 'areaId', 'startsAt', 'lineId', 'spotId']))
    return { problem: 'not an assignment' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!isWhole(x.made, 1)) return { problem: 'bad time' };
  if (typeof x.areaId !== 'string' || !AREA_ID.test(x.areaId)) return { problem: 'bad area id' };
  if (!isWhole(x.startsAt, 1) || !startsOnIndiaHour(x.startsAt))
    return { problem: 'bad start time' };
  if (x.lineId !== null && !isId(x.lineId)) return { problem: 'bad line id' };
  if (x.spotId !== null && !isId(x.spotId)) return { problem: 'bad spot id' };
  return {
    made: x.made,
    areaId: x.areaId,
    startsAt: x.startsAt,
    carry: { lineId: x.lineId ?? undefined, spotId: x.spotId ?? undefined },
  };
}
