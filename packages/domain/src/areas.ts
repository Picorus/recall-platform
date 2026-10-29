// P1.1 Areas: the map shapes brands buy. Every change is a new version; a booking keeps the version
// it was sold on, so redrawing an area never changes an old report.
import {
  distanceToBorderMeters,
  isSimpleRing,
  MAX_OVERLAP_SQM,
  overlapSqm,
  pointInRing,
  ringGap,
  ringOverlap,
  sharedBorderMeters,
  type LatLng,
  type Ring,
} from './geo.js';
import { parseUtcIso } from './time.js';

/** P1.1.1: the edge zone around an area, in metres. A default; each area version carries its own. */
export const DEFAULT_EDGE_METERS = 300;
/** Upper bound on an edge zone, so a typo cannot swallow the city. */
export const MAX_EDGE_METERS = 2_000;

export interface AreaVersion {
  /** Stable id, e.g. "hyd-madhapur". Never reused. */
  readonly areaId: string;
  /** 1, 2, 3… A new version for every change. */
  readonly version: number;
  readonly name: string;
  readonly city: string;
  readonly ring: Ring;
  readonly edgeMeters: number;
  /** When this version starts to apply, as a UTC ISO string. */
  readonly validFrom: string;
  /** Draft shapes are for ops to correct; they cannot be sold. */
  readonly draft: boolean;
  /**
   * On or off, set by a super admin (Prateek, 22 Oct 2026). An area that is off cannot be sold,
   * and plays and hours there do not count. Turning it off or on is a new version, never a delete.
   */
  readonly active: boolean;
}

export type AreaProblem =
  | { readonly kind: 'bad-id'; readonly detail: string }
  | { readonly kind: 'bad-shape'; readonly detail: string }
  | { readonly kind: 'bad-edge'; readonly detail: string }
  | { readonly kind: 'bad-date'; readonly detail: string }
  /** The insides overlap by `sqm` square metres (more than MAX_OVERLAP_SQM). */
  | { readonly kind: 'overlap'; readonly withAreaId: string; readonly sqm: number };

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function shapeProblems(area: AreaVersion): AreaProblem[] {
  const problems: AreaProblem[] = [];
  if (!ID.test(area.areaId)) {
    problems.push({ kind: 'bad-id', detail: 'use lower-case letters, digits and dashes' });
  }
  const corners = area.ring.every(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180,
  );
  if (!corners) problems.push({ kind: 'bad-shape', detail: 'a corner is not a real map point' });
  else if (!isSimpleRing(area.ring)) {
    problems.push({
      kind: 'bad-shape',
      detail: 'needs 3+ corners and its border must not cross itself',
    });
  }
  if (
    !Number.isInteger(area.edgeMeters) ||
    area.edgeMeters < 0 ||
    area.edgeMeters > MAX_EDGE_METERS
  ) {
    problems.push({
      kind: 'bad-edge',
      detail: `edge zone must be 0–${MAX_EDGE_METERS} whole metres`,
    });
  }
  if (Number.isNaN(parseUtcIso(area.validFrom))) {
    problems.push({
      kind: 'bad-date',
      detail: 'validFrom must be a UTC time like 2026-11-01T00:00:00Z',
    });
  }
  return problems;
}

/**
 * P1.1.4 and P1.1.7: checks run when an area is saved. Neighbouring areas may share a border (whole
 * lines or single corners), but their insides must never overlap (Prateek, 29 Oct 2026): an
 * overlap of more than MAX_OVERLAP_SQM (1 m²) is refused. Pass every version of the other areas
 * that is in force at or after this version's `validFrom`. Returns no problems when it can be saved.
 */
export function checkArea(area: AreaVersion, others: readonly AreaVersion[]): AreaProblem[] {
  const problems = shapeProblems(area);
  if (problems.some((p) => p.kind === 'bad-shape')) return problems;
  // An area that is off does not block others; turning it back on runs this check again.
  if (!area.active) return problems;
  const worst = new Map<string, number>();
  for (const other of others) {
    if (other.areaId === area.areaId || !other.active || other.ring.length < 3) continue;
    const sqm = overlapSqm(area.ring, other.ring);
    if (sqm > MAX_OVERLAP_SQM && sqm > (worst.get(other.areaId) ?? 0)) worst.set(other.areaId, sqm);
  }
  // One problem per neighbour (two of its versions may be in force: the newest and the published).
  for (const [withAreaId, sqm] of worst)
    problems.push({ kind: 'overlap', withAreaId, sqm: Math.ceil(sqm) });
  return problems;
}

/** How a shape sits next to one neighbouring area, for the Areas page's Check (P1.1.7). */
export interface AreaNeighbour {
  readonly areaId: string;
  readonly name: string;
  /** Metres between the borders at their nearest; 0 when they touch or overlap. */
  readonly gapMeters: number;
  /** The two nearest points, to draw the gap (only when there is one). */
  readonly gap: { readonly from: LatLng; readonly to: LatLng } | null;
  /** Metres of border shared with it. */
  readonly sharedMeters: number;
  /** Square metres the insides overlap (more than 1 is refused on save), and where. */
  readonly overlapSqm: number;
  readonly overlap: readonly Ring[];
}

/**
 * The areas that are on within `withinMeters` of a shape: the gap to each, the border shared, and
 * any overlap, nearest first. Of an area's versions in force, the one that overlaps most counts.
 */
export function neighboursOf(
  ring: Ring,
  others: readonly AreaVersion[],
  withinMeters = 1_000,
): AreaNeighbour[] {
  const worst = new Map<string, AreaNeighbour>();
  if (!isSimpleRing(ring)) return [];
  for (const o of others) {
    if (!o.active || !isSimpleRing(o.ring)) continue;
    const g = ringGap(ring, o.ring);
    if (g.meters > withinMeters) continue;
    const overlap = g.meters > 0 ? { sqm: 0, pieces: [] } : ringOverlap(ring, o.ring);
    const n: AreaNeighbour = {
      areaId: o.areaId,
      name: o.name,
      gapMeters: g.meters,
      gap: g.meters > 0 ? { from: g.from, to: g.to } : null,
      sharedMeters: g.meters > 0 ? 0 : sharedBorderMeters(ring, o.ring),
      overlapSqm: overlap.sqm,
      overlap: overlap.sqm > MAX_OVERLAP_SQM ? overlap.pieces : [],
    };
    const was = worst.get(o.areaId);
    const worse =
      !was ||
      n.overlapSqm > was.overlapSqm ||
      (n.overlapSqm === was.overlapSqm && n.gapMeters < was.gapMeters);
    if (worse) worst.set(o.areaId, n);
  }
  return [...worst.values()].sort(
    (a, b) => a.gapMeters - b.gapMeters || a.name.localeCompare(b.name),
  );
}

export class AreaError extends Error {
  constructor(readonly problems: readonly AreaProblem[]) {
    super(`Area cannot be saved: ${problems.map((p) => p.kind).join(', ')}`);
  }
}

export interface NewArea {
  readonly areaId: string;
  readonly name: string;
  readonly city: string;
  readonly ring: Ring;
  readonly edgeMeters?: number;
  readonly validFrom: string;
  readonly draft?: boolean;
  readonly active?: boolean;
}

export function createArea(input: NewArea, others: readonly AreaVersion[]): AreaVersion {
  const area: AreaVersion = {
    areaId: input.areaId,
    version: 1,
    name: input.name,
    city: input.city,
    ring: input.ring,
    edgeMeters: input.edgeMeters ?? DEFAULT_EDGE_METERS,
    validFrom: input.validFrom,
    draft: input.draft ?? false,
    active: input.active ?? true,
  };
  if (others.some((o) => o.areaId === area.areaId)) {
    throw new AreaError([{ kind: 'bad-id', detail: 'an area with this id already exists' }]);
  }
  const problems = checkArea(area, others);
  if (problems.length > 0) throw new AreaError(problems);
  return area;
}

/** Fields to change; a field left out (or undefined) keeps its old value. */
export type AreaChanges = {
  readonly [K in 'name' | 'ring' | 'edgeMeters' | 'draft' | 'active']?: AreaVersion[K] | undefined;
};

/** The newest version in an area's history; refuses a mixed or empty history. */
export function latestVersion(history: readonly AreaVersion[]): AreaVersion {
  const first = history[0];
  if (!first || history.some((v) => v.areaId !== first.areaId)) {
    throw new RangeError('History must hold versions of one area');
  }
  return history.reduce((a, b) => (b.version > a.version ? b : a));
}

/**
 * P1.1.2: a change makes the next version; earlier ones are kept, untouched. Takes the area's whole
 * history so a change always builds on the newest version (two "version 2"s cannot happen).
 */
export function reviseArea(
  history: readonly AreaVersion[],
  changes: AreaChanges,
  validFrom: string,
  others: readonly AreaVersion[],
): AreaVersion {
  const current = latestVersion(history);
  const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  const next: AreaVersion = { ...current, ...given, version: current.version + 1, validFrom };
  const problems = checkArea(next, others);
  if (!(parseUtcIso(validFrom) > parseUtcIso(current.validFrom))) {
    problems.push({
      kind: 'bad-date',
      detail: 'a new version must start after the one it replaces',
    });
  }
  if (problems.length > 0) throw new AreaError(problems);
  return next;
}

/**
 * Turn an area on or off from `validFrom`: a new version, checked like any other change. It builds
 * on the newest published version, never on a pending draft: a draft is a proposal, and an on/off
 * that copied it would be a draft too and never take effect (review P3.5). The pending draft is
 * left behind in the history; it can be saved again later.
 */
export function setAreaActive(
  history: readonly AreaVersion[],
  active: boolean,
  validFrom: string,
  others: readonly AreaVersion[],
): AreaVersion {
  const latest = latestVersion(history);
  const published = history
    .filter((v) => !v.draft)
    .reduce<AreaVersion | undefined>((a, b) => (!a || b.version > a.version ? b : a), undefined);
  if (!latest.draft || !published) return reviseArea(history, { active }, validFrom, others);
  // The newest number, the published shape.
  const base: AreaVersion = { ...published, version: latest.version, validFrom: latest.validFrom };
  return reviseArea([base], { active }, validFrom, others);
}

/**
 * The other areas' versions a change starting at `validFrom` must not meet: for each other area,
 * the version in force then (its newest one, and its newest published one, which may differ when a
 * draft is pending) and every version starting later. Old shapes no longer in force never block.
 */
export function othersInForce(
  all: readonly AreaVersion[],
  areaId: string,
  validFrom: string,
): AreaVersion[] {
  const at = parseUtcIso(validFrom);
  const out: AreaVersion[] = [];
  const ids = new Set(all.filter((a) => a.areaId !== areaId).map((a) => a.areaId));
  for (const id of ids) {
    const h = all.filter((a) => a.areaId === id);
    const newest = versionAt(h, validFrom);
    const published = publishedAt(h, validFrom);
    for (const v of h)
      if (v === newest || v === published || parseUtcIso(v.validFrom) > at) out.push(v);
  }
  return out;
}

/** The version in force at `instant` (UTC ISO), or undefined before the first one. */
export function versionAt(
  history: readonly AreaVersion[],
  instant: string,
): AreaVersion | undefined {
  const at = parseUtcIso(instant);
  if (Number.isNaN(at)) throw new RangeError(`Not a UTC time: ${instant}`);
  let found: AreaVersion | undefined;
  for (const v of history) {
    if (parseUtcIso(v.validFrom) <= at && (!found || v.version > found.version)) found = v;
  }
  return found;
}

/** The published version in force at `instant`. A draft is a proposal, never in force. */
export function publishedAt(
  history: readonly AreaVersion[],
  instant: string,
): AreaVersion | undefined {
  return versionAt(
    history.filter((v) => !v.draft),
    instant,
  );
}

export type Place =
  | { readonly kind: 'inside'; readonly areaId: string; readonly version: number }
  | {
      readonly kind: 'edge';
      readonly areaId: string;
      readonly version: number;
      readonly metersOutside: number;
    }
  | { readonly kind: 'outside' };

/** "inside:hyd-madhapur@3", "edge:hyd-madhapur@3" or "outside": a stable key for a place. */
export function placeKey(place: Place): string {
  return place.kind === 'outside' ? 'outside' : `${place.kind}:${place.areaId}@${place.version}`;
}

function byId(a: AreaVersion, b: AreaVersion): number {
  return a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0;
}

/**
 * A point closer than this to an area's border is on that border (1 mm: far finer than any GPS fix,
 * far coarser than floating-point error, so the screen and the cloud agree).
 */
export const ON_BORDER_M = 0.001;

/**
 * Where a point is: inside an area, in an area's edge zone, or outside every area that is on.
 * 1. Inside an area (more than 1 mm from its border): that area. Inside always wins over another
 *    area's edge zone, so a bike in Kondapur is never at Madhapur's edge (P1.1.7).
 * 2. On a border (within 1 mm), such as the line two neighbours share: of the areas whose border
 *    it is on, the one with the smaller id. Exactly one answer, the same on the screen (Kotlin
 *    `Areas.locate`) as in the cloud (shared cases: test-vectors/areas-locate.json).
 * 3. Otherwise the edge zone it is in; in two edge zones, the nearer area (P1.1.4); within 1 mm
 *    of each other is a tie, and ties go to the smaller id.
 */
export function locate(point: LatLng, areas: readonly AreaVersion[]): Place {
  const sorted = areas.filter((a) => a.active).sort(byId);
  const known = new Map<AreaVersion, number>();
  const border = (area: AreaVersion) => {
    let m = known.get(area);
    if (m === undefined) {
      m = distanceToBorderMeters(point, area.ring);
      known.set(area, m);
    }
    return m;
  };
  for (const area of sorted) {
    if (pointInRing(point, area.ring) && border(area) > ON_BORDER_M) {
      return { kind: 'inside', areaId: area.areaId, version: area.version };
    }
  }
  for (const area of sorted) {
    if (border(area) <= ON_BORDER_M) {
      return { kind: 'inside', areaId: area.areaId, version: area.version };
    }
  }
  let best: { area: AreaVersion; meters: number } | undefined;
  for (const area of sorted) {
    const meters = border(area);
    // Nearer by more than 1 mm; closer than that is a tie (floating point alone could decide it).
    if (meters <= area.edgeMeters && (!best || meters < best.meters - ON_BORDER_M))
      best = { area, meters };
  }
  return best
    ? {
        kind: 'edge',
        areaId: best.area.areaId,
        version: best.area.version,
        metersOutside: best.meters,
      }
    : { kind: 'outside' };
}
