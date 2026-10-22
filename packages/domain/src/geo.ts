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

function onSegment(a: Xy, b: Xy, p: Xy): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** True when the two segments share any point, touching included. */
function segmentsMeet(a: Xy, b: Xy, c: Xy, d: Xy): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
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
        const sameDirection =
          (far.x - shared.x) * (near.x - shared.x) + (far.y - shared.y) * (near.y - shared.y) > 0;
        if (orientation(near, shared, far) === 0 && sameDirection) return false;
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
