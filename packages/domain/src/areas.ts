// P1.1 Areas: the map shapes brands buy. Every change is a new version; a booking keeps the version
// it was sold on, so redrawing an area never changes an old report.
import {
  distanceToBorderMeters,
  isSimpleRing,
  pointInRing,
  ringsMeet,
  type LatLng,
  type Ring,
} from './geo.js';

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
  | { readonly kind: 'overlap'; readonly withAreaId: string };

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
  if (Number.isNaN(Date.parse(area.validFrom))) {
    problems.push({ kind: 'bad-date', detail: 'validFrom is not a date' });
  }
  return problems;
}

/**
 * P1.1.4: checks run when an area is saved. Shapes may not overlap or touch any other area's
 * current shape (leave a gap; the edge zones cover it). Returns no problems when it can be saved.
 */
export function checkArea(area: AreaVersion, others: readonly AreaVersion[]): AreaProblem[] {
  const problems = shapeProblems(area);
  if (problems.some((p) => p.kind === 'bad-shape')) return problems;
  // An area that is off does not block others; turning it back on runs this check again.
  if (!area.active) return problems;
  for (const other of others) {
    if (other.areaId === area.areaId || !other.active) continue;
    if (ringsMeet(area.ring, other.ring))
      problems.push({ kind: 'overlap', withAreaId: other.areaId });
  }
  return problems;
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

export type AreaChanges = Partial<
  Pick<AreaVersion, 'name' | 'ring' | 'edgeMeters' | 'draft' | 'active'>
>;

/** P1.1.2: a change makes the next version; the previous one is kept, untouched. */
export function reviseArea(
  current: AreaVersion,
  changes: AreaChanges,
  validFrom: string,
  others: readonly AreaVersion[],
): AreaVersion {
  const next: AreaVersion = { ...current, ...changes, version: current.version + 1, validFrom };
  const problems = checkArea(next, others);
  if (!(Date.parse(validFrom) > Date.parse(current.validFrom))) {
    problems.push({
      kind: 'bad-date',
      detail: 'a new version must start after the one it replaces',
    });
  }
  if (problems.length > 0) throw new AreaError(problems);
  return next;
}

/** Turn an area on or off from `validFrom`: a new version, checked like any other change. */
export function setAreaActive(
  current: AreaVersion,
  active: boolean,
  validFrom: string,
  others: readonly AreaVersion[],
): AreaVersion {
  return reviseArea(current, { active }, validFrom, others);
}

/** The version in force at `instant` (UTC ISO), or undefined before the first one. */
export function versionAt(
  history: readonly AreaVersion[],
  instant: string,
): AreaVersion | undefined {
  const at = Date.parse(instant);
  let found: AreaVersion | undefined;
  for (const v of history) {
    if (Date.parse(v.validFrom) <= at && (!found || v.version > found.version)) found = v;
  }
  return found;
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

function byId(a: AreaVersion, b: AreaVersion): number {
  return a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0;
}

/**
 * Where a point is: inside an area, in an area's edge zone, or outside every area that is on.
 * A point in two edge zones belongs to the nearer area (P1.1.4); ties go to the smaller id.
 */
export function locate(point: LatLng, areas: readonly AreaVersion[]): Place {
  const sorted = areas.filter((a) => a.active).sort(byId);
  for (const area of sorted) {
    if (pointInRing(point, area.ring)) {
      return { kind: 'inside', areaId: area.areaId, version: area.version };
    }
  }
  let best: { area: AreaVersion; meters: number } | undefined;
  for (const area of sorted) {
    const meters = distanceToBorderMeters(point, area.ring);
    if (meters <= area.edgeMeters && (!best || meters < best.meters)) best = { area, meters };
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
