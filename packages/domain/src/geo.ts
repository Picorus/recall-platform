// Small, exact-enough geometry for one city. Distances use a flat projection around a nearby
// latitude: over Hyderabad's ~40 km the error is far below a GPS fix's own error (a few metres).

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

/** A closed shape given as its corners in order, without repeating the first corner at the end. */
export type Ring = readonly LatLng[];

export const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Xy {
  readonly x: number;
  readonly y: number;
}

/** Metres east (x) and north (y) of `origin`. */
function project(p: LatLng, origin: LatLng): Xy {
  return {
    x: (p.lng - origin.lng) * RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD),
    y: (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
  };
}

function segmentDistance(p: Xy, a: Xy, b: Xy): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Item `i`, or a clear error instead of `undefined`. */
function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new RangeError(`No item ${i}`);
  return item;
}

function edges<T>(ring: readonly T[]): [T, T][] {
  return ring.map((p, i) => [p, at(ring, (i + 1) % ring.length)] as [T, T]);
}

/** True when the point is inside the shape (ray casting). Points exactly on the border may go either way. */
export function pointInRing(p: LatLng, ring: Ring): boolean {
  let inside = false;
  for (const [a, b] of edges(ring)) {
    if (a.lat > p.lat !== b.lat > p.lat) {
      const lngAtLat = a.lng + ((p.lat - a.lat) / (b.lat - a.lat)) * (b.lng - a.lng);
      if (p.lng < lngAtLat) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance in metres from the point to the shape's border (0 means on it). */
export function distanceToBorderMeters(p: LatLng, ring: Ring): number {
  const origin = p;
  const q = project(p, origin);
  let best = Infinity;
  for (const [a, b] of edges(ring)) {
    best = Math.min(best, segmentDistance(q, project(a, origin), project(b, origin)));
  }
  return best;
}

/** Area in square metres (always positive). */
export function ringAreaSqm(ring: Ring): number {
  if (ring.length < 3) return 0;
  const origin = at(ring, 0);
  let twice = 0;
  for (const [a, b] of edges(ring.map((p) => project(p, origin)))) twice += a.x * b.y - b.x * a.y;
  return Math.abs(twice) / 2;
}

function orientation(a: Xy, b: Xy, c: Xy): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Borders closer than this count as touching (floating point cannot say "exactly on a line"). */
const TOUCH_M = 0.01;

/** True when the two segments share any point, touching included. */
function segmentsMeet(a: Xy, b: Xy, c: Xy, d: Xy): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) return true;
  return (
    segmentDistance(c, a, b) < TOUCH_M ||
    segmentDistance(d, a, b) < TOUCH_M ||
    segmentDistance(a, c, d) < TOUCH_M ||
    segmentDistance(b, c, d) < TOUCH_M
  );
}

/** True when no border crosses or touches itself, and the shape has at least 3 corners and some area. */
export function isSimpleRing(ring: Ring): boolean {
  if (ring.length < 3) return false;
  if (ringAreaSqm(ring) < 1) return false;
  const origin = at(ring, 0);
  const sides = edges(ring.map((p) => project(p, origin)));
  if (sides.some(([a, b]) => a.x === b.x && a.y === b.y)) return false;
  for (let i = 0; i < sides.length; i++) {
    for (let j = i + 1; j < sides.length; j++) {
      const neighbours = j === i + 1 || (i === 0 && j === sides.length - 1);
      const [a, b] = at(sides, i);
      const [c, d] = at(sides, j);
      if (neighbours) {
        // Neighbouring sides share one corner; they must not fold back over each other.
        const shared = j === i + 1 ? b : a;
        const far = j === i + 1 ? d : c;
        const near = j === i + 1 ? a : b;
        if (
          segmentDistance(far, shared, near) < TOUCH_M ||
          segmentDistance(near, shared, far) < TOUCH_M
        ) {
          return false;
        }
        continue;
      }
      if (segmentsMeet(a, b, c, d)) return false;
    }
  }
  return true;
}

/** True when the two shapes share any point: crossing or touching borders, or one inside the other. */
export function ringsMeet(a: Ring, b: Ring): boolean {
  const origin = at(a, 0);
  const sa = edges(a.map((p) => project(p, origin)));
  const sb = edges(b.map((p) => project(p, origin)));
  for (const [p, q] of sa) {
    for (const [r, s] of sb) if (segmentsMeet(p, q, r, s)) return true;
  }
  return pointInRing(at(a, 0), b) || pointInRing(at(b, 0), a);
}

// ---------------------------------------------------------------- P1.1.7 shared borders

/**
 * Neighbouring areas may share a border (Prateek, 29 Oct 2026); their insides must never overlap.
 * Floating point cannot put a corner exactly on a slanted line, so an overlap counts only above
 * this many square metres (a sliver 1 mm wide along 1 km of shared border is 1 m²).
 */
export const MAX_OVERLAP_SQM = 1;

/** Corners closer to each other than this count as the same corner. */
const SAME_M = 1e-6;

function unproject(p: Xy, origin: LatLng): LatLng {
  return {
    lat: origin.lat + p.y / (RAD * EARTH_RADIUS_M),
    lng: origin.lng + p.x / (RAD * EARTH_RADIUS_M * Math.cos(origin.lat * RAD)),
  };
}

function cross(a: Xy, b: Xy, c: Xy): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function twiceSignedArea(poly: readonly Xy[]): number {
  let twice = 0;
  for (const [a, b] of edges(poly)) twice += a.x * b.y - b.x * a.y;
  return twice;
}

/** The same corners, counter-clockwise. */
function counterClockwise(poly: readonly Xy[]): Xy[] {
  return twiceSignedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

type Triangle = readonly [Xy, Xy, Xy];

/** Inside the counter-clockwise triangle, or on its border. */
function inTriangle(p: Xy, [a, b, c]: Triangle): boolean {
  return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
}

const same = (p: Xy, q: Xy) => Math.abs(p.x - q.x) < SAME_M && Math.abs(p.y - q.y) < SAME_M;

/**
 * A simple shape cut into triangles (ear clipping), counter-clockwise. Corners in a straight line
 * add no area and are dropped. Together the triangles cover the shape exactly once.
 */
function triangles(shape: readonly Xy[]): Triangle[] {
  const v = counterClockwise(shape);
  const out: Triangle[] = [];
  let guard = v.length * v.length + 10;
  while (v.length > 3 && guard-- > 0) {
    let cut = -1;
    for (let i = 0; i < v.length && cut < 0; i++) {
      const prev = at(v, (i + v.length - 1) % v.length);
      const cur = at(v, i);
      const next = at(v, (i + 1) % v.length);
      const c = cross(prev, cur, next);
      const scale =
        Math.hypot(cur.x - prev.x, cur.y - prev.y) * Math.hypot(next.x - cur.x, next.y - cur.y);
      if (Math.abs(c) <= 1e-12 * scale) {
        // A corner on the straight line between its neighbours: no area, just drop it.
        v.splice(i, 1);
        cut = -2;
        break;
      }
      if (c < 0) continue;
      const t: Triangle = [prev, cur, next];
      const blocked = v.some(
        (p) =>
          p !== prev &&
          p !== cur &&
          p !== next &&
          !same(p, prev) &&
          !same(p, cur) &&
          !same(p, next) &&
          inTriangle(p, t),
      );
      if (!blocked) cut = i;
    }
    if (cut === -2) continue;
    if (cut < 0) {
      // Only floating point can leave no ear in a simple shape: cut the most convex corner.
      let best = 0;
      let bestC = -Infinity;
      for (let i = 0; i < v.length; i++) {
        const c = cross(at(v, (i + v.length - 1) % v.length), at(v, i), at(v, (i + 1) % v.length));
        if (c > bestC) [best, bestC] = [i, c];
      }
      cut = best;
    }
    out.push([at(v, (cut + v.length - 1) % v.length), at(v, cut), at(v, (cut + 1) % v.length)]);
    v.splice(cut, 1);
  }
  if (v.length === 3 && twiceSignedArea(v) > 0) out.push([at(v, 0), at(v, 1), at(v, 2)]);
  return out;
}

/** A convex shape cut down to the part inside a counter-clockwise triangle (Sutherland–Hodgman). */
function clipToTriangle(subject: readonly Xy[], clip: Triangle): Xy[] {
  let out: Xy[] = [...subject];
  for (const [a, b] of edges(clip)) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const p = at(input, i);
      const q = at(input, (i + 1) % input.length);
      const sp = cross(a, b, p);
      const sq = cross(a, b, q);
      if (sp >= 0) out.push(p);
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function boxOf(points: readonly Xy[]): Box {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

const boxesMeet = (a: Box, b: Box) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;

/**
 * Where the insides of two simple shapes overlap, as pieces (each a convex shape), with their
 * total area. Each shape is cut into triangles; every pair of triangles is clipped one by the other.
 * Shapes that only share a border or a corner give (next to) nothing: a clipped piece along a
 * shared line has no width. Works for any simple shapes, not only convex ones.
 */
export function ringOverlap(a: Ring, b: Ring): { readonly sqm: number; readonly pieces: Ring[] } {
  if (a.length < 3 || b.length < 3) return { sqm: 0, pieces: [] };
  const origin = at(a, 0);
  const pa = a.map((p) => project(p, origin));
  const pb = b.map((p) => project(p, origin));
  if (!boxesMeet(boxOf(pa), boxOf(pb))) return { sqm: 0, pieces: [] };
  const tb = triangles(pb).map((t) => ({ t, box: boxOf(t) }));
  let sqm = 0;
  const pieces: Ring[] = [];
  for (const t of triangles(pa)) {
    const box = boxOf(t);
    for (const other of tb) {
      if (!boxesMeet(box, other.box)) continue;
      const piece = clipToTriangle(t, other.t);
      if (piece.length < 3) continue;
      const size = Math.abs(twiceSignedArea(piece)) / 2;
      sqm += size;
      if (size > 0.01) pieces.push(piece.map((p) => unproject(p, origin)));
    }
  }
  return { sqm, pieces };
}

/** Square metres where the insides of the two shapes overlap (0 when they only touch). */
export function overlapSqm(a: Ring, b: Ring): number {
  return ringOverlap(a, b).sqm;
}

/** Shared border closer than this counts as one line (a corner snapped onto a border to 6 decimals is within 8 cm). */
const SHARED_M = 0.1;

/** Metres of border the two shapes share (lines lying on each other, within 10 cm). */
export function sharedBorderMeters(a: Ring, b: Ring): number {
  if (a.length < 2 || b.length < 2) return 0;
  const origin = at(a, 0);
  const sa = edges(a.map((p) => project(p, origin)));
  const sb = edges(b.map((p) => project(p, origin)));
  let total = 0;
  for (const [p, q] of sa) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len === 0) continue;
    const ux = (q.x - p.x) / len;
    const uy = (q.y - p.y) / len;
    for (const [r, s] of sb) {
      if (segmentDistance(r, p, q) > SHARED_M && segmentDistance(s, p, q) > SHARED_M) continue;
      // Both ends of the other line must sit on this line (not just one end touching it).
      const off = (z: Xy) => Math.abs((z.x - p.x) * uy - (z.y - p.y) * ux);
      if (off(r) > SHARED_M || off(s) > SHARED_M) continue;
      const tr = (r.x - p.x) * ux + (r.y - p.y) * uy;
      const ts = (s.x - p.x) * ux + (s.y - p.y) * uy;
      const lo = Math.max(0, Math.min(tr, ts));
      const hi = Math.min(len, Math.max(tr, ts));
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

/**
 * How far apart two shapes are at their nearest, with the two nearest points (0 when they touch
 * or overlap). Used to show the gap between neighbouring areas.
 */
export function ringGap(
  a: Ring,
  b: Ring,
): { readonly meters: number; readonly from: LatLng; readonly to: LatLng } {
  const origin = at(a, 0);
  const pa = a.map((p) => project(p, origin));
  const pb = b.map((p) => project(p, origin));
  let best = { meters: Infinity, from: at(pa, 0), to: at(pb, 0) };
  const nearest = (p: Xy, s: readonly Xy[], swap: boolean) => {
    for (const [c, d] of edges(s)) {
      const dx = d.x - c.x;
      const dy = d.y - c.y;
      const len2 = dx * dx + dy * dy;
      const t =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - c.x) * dx + (p.y - c.y) * dy) / len2));
      const q = { x: c.x + t * dx, y: c.y + t * dy };
      const m = Math.hypot(p.x - q.x, p.y - q.y);
      if (m < best.meters)
        best = swap ? { meters: m, from: q, to: p } : { meters: m, from: p, to: q };
    }
  };
  if (ringsMeet(a, b)) {
    return { meters: 0, from: at(a, 0), to: at(a, 0) };
  }
  for (const p of pa) nearest(p, pb, false);
  for (const p of pb) nearest(p, pa, true);
  return {
    meters: best.meters,
    from: unproject(best.from, origin),
    to: unproject(best.to, origin),
  };
}
