// The Areas page's helpers: corners as text (one "lat, lng" per line: easy to check and paste), and
// drawing next to a neighbour (P1.1.7: neighbouring areas may share a border, never overlap):
// snapping a corner onto a neighbour's corner or border, following its border, closing a gap.

export interface Corner {
  readonly lat: number;
  readonly lng: number;
}

/** Corners are kept to 6 decimals (about 10 cm), as the Areas page has always saved them. */
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
const six = (x: number) => (round6(x) === x ? x.toFixed(6) : String(x));

/**
 * "17.448000, 78.391000" per line, 6 decimals (about 10 cm). A corner copied from a neighbour that
 * was saved with more decimals keeps them all, so the shared border stays exactly the same line.
 */
export function cornersText(ring: readonly Corner[]): string {
  return ring.map((p) => `${six(p.lat)}, ${six(p.lng)}`).join('\n');
}

/** Corners from text, or what is wrong (blank lines are skipped). */
export function parseCorners(text: string): { ring: Corner[] } | { problem: string } {
  const ring: Corner[] = [];
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(line);
    const lat = Number(m?.[1]);
    const lng = Number(m?.[2]);
    if (!m || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return { problem: `Line ${i + 1} is not "latitude, longitude"` };
    ring.push({ lat, lng });
  }
  if (ring.length < 3) return { problem: 'An area needs at least 3 corners' };
  return { ring };
}

// ---------------------------------------------------------------- snapping (P1.1.7)

/** A corner closer than this to a neighbour's corner or border snaps onto it (when zoomed in). */
export const SNAP_METRES = 30;
/** When zoomed out, 30 m is too small to hit: the snap reaches this many screen pixels instead. */
export const SNAP_PIXELS = 12;

/** Metres one screen pixel covers at this zoom and latitude (MapLibre's 512-pixel tiles). */
export function metresPerPixel(zoom: number, lat: number): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/** How far a corner snaps at this zoom: 30 m, or 12 screen pixels when that is more. */
export function snapMetres(zoom: number, lat: number): number {
  return Math.max(SNAP_METRES, SNAP_PIXELS * metresPerPixel(zoom, lat));
}

export interface Neighbour {
  readonly areaId: string;
  readonly name: string;
  readonly ring: readonly Corner[];
}

/** Where a corner snapped: onto a neighbour's corner `at`, or onto its border `at + t` (0 < t < 1). */
export interface Snap {
  readonly areaId: string;
  readonly name: string;
  readonly kind: 'corner' | 'border';
  /** Position along the neighbour's border: corner i is i, a point on the side from i to i+1 is i + t. */
  readonly at: number;
  readonly point: Corner;
}

const M_PER_DEG = 111_195;

/** Metres east and north of `o` (flat, fine over a few kilometres). */
function xy(p: Corner, o: Corner) {
  return {
    x: (p.lng - o.lng) * M_PER_DEG * Math.cos((o.lat * Math.PI) / 180),
    y: (p.lat - o.lat) * M_PER_DEG,
  };
}

const metres = (a: Corner, b: Corner) => {
  const d = xy(b, a);
  return Math.hypot(d.x, d.y);
};

/** +1 when the shape's corners run counter-clockwise (its inside on the left of each side), else -1. */
function turn(ring: readonly Corner[]): number {
  const o = ring[0];
  if (!o) return 1;
  let twice = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    const p = xy(a, o);
    const q = xy(b, o);
    twice += p.x * q.y - q.x * p.y;
  });
  return twice >= 0 ? 1 : -1;
}

/**
 * The point on the side a→b nearest to `p`, to 6 decimals and never inside the neighbour: of the
 * 6-decimal points around the exact spot, the one nearest the line that is on it or just outside.
 * So a border snapped this way only ever touches (P1.1.7); at worst it leaves a crack a few
 * centimetres wide, never an overlap.
 */
function ontoSide(p: Corner, a: Corner, b: Corner, sign: number): { point: Corner; t: number } {
  const o = a;
  const pa = xy(a, o);
  const pb = xy(b, o);
  const pp = xy(p, o);
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pp.x - pa.x) * dx + (pp.y - pa.y) * dy) / len2));
  const exact = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
  let best: { point: Corner; off: number; far: number } | undefined;
  for (const dLat of [-1, 0, 1]) {
    for (const dLng of [-1, 0, 1]) {
      const c = {
        lat: round6(round6(exact.lat) + dLat / 1e6),
        lng: round6(round6(exact.lng) + dLng / 1e6),
      };
      const pc = xy(c, o);
      const side = (dx * (pc.y - pa.y) - dy * (pc.x - pa.x)) * sign;
      if (side > 0) continue; // inside the neighbour
      const off = len2 === 0 ? 0 : Math.abs(side) / Math.sqrt(len2);
      const far = metres(c, exact);
      if (!best || off < best.off - 1e-9 || (Math.abs(off - best.off) <= 1e-9 && far < best.far))
        best = { point: c, off, far };
    }
  }
  return { point: best?.point ?? exact, t };
}

/**
 * Snap a corner dropped at `p`: onto the nearest neighbour corner within `radius` metres, else
 * onto the nearest neighbour border within `radius`, else left where it was (to 6 decimals).
 */
export function snapCorner(
  p: Corner,
  neighbours: readonly Neighbour[],
  radius: number,
): { point: Corner; snap: Snap | undefined } {
  let corner: { snap: Snap; m: number } | undefined;
  let border: { snap: Snap; m: number } | undefined;
  for (const n of neighbours) {
    const sign = turn(n.ring);
    n.ring.forEach((c, i) => {
      const m = metres(p, c);
      if (m <= radius && (!corner || m < corner.m))
        corner = { snap: { areaId: n.areaId, name: n.name, kind: 'corner', at: i, point: c }, m };
      const next = n.ring[(i + 1) % n.ring.length];
      if (!next) return;
      const s = ontoSide(p, c, next, sign);
      const sm = metres(p, s.point);
      if (s.t > 0 && s.t < 1 && sm <= radius && (!border || sm < border.m))
        border = {
          snap: { areaId: n.areaId, name: n.name, kind: 'border', at: i + s.t, point: s.point },
          m: sm,
        };
    });
  }
  const snap = (corner ?? border)?.snap;
  return snap
    ? { point: snap.point, snap }
    : { point: { lat: round6(p.lat), lng: round6(p.lng) }, snap: undefined };
}

/** Length of a path through these points, metres. */
const along = (pts: readonly Corner[]) =>
  pts.reduce((sum, p, i) => (i === 0 ? 0 : sum + metres(pts[i - 1] ?? p, p)), 0);

/**
 * The neighbour's own corners between two snapped points on its border, the shorter way round,
 * so the new border follows the neighbour's exactly instead of cutting across a bend.
 */
export function traceBetween(ring: readonly Corner[], from: Snap, to: Snap): Corner[] {
  const n = ring.length;
  if (n < 3 || from.areaId !== to.areaId) return [];
  const mod = (x: number) => ((x % n) + n) % n;
  const span = mod(to.at - from.at);
  if (span === 0) return [];
  // Corner k lies `mod(k - from.at)` along the border from `from`, going forward.
  const ahead = ring.map((c, k) => ({ c, d: mod(k - from.at) }));
  const forward = ahead
    .filter((x) => x.d > 0 && x.d < span)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.c);
  const backward = ahead
    .filter((x) => x.d > span)
    .sort((a, b) => b.d - a.d)
    .map((x) => x.c);
  const f = along([from.point, ...forward, to.point]);
  const b = along([from.point, ...backward, to.point]);
  return f <= b ? forward : backward;
}

/**
 * Drawing: the corner clicked at `p` added at the end, snapped when `radius` > 0. When it and the
 * corner before it both sit on the same neighbour, the neighbour's corners in between are added
 * too, so the new border follows the neighbour's. `snaps` says where each corner snapped.
 */
export function addCorner(
  ring: readonly Corner[],
  snaps: readonly (Snap | undefined)[],
  p: Corner,
  neighbours: readonly Neighbour[],
  radius: number,
): { ring: Corner[]; snaps: (Snap | undefined)[]; snap: Snap | undefined } {
  const s =
    radius > 0
      ? snapCorner(p, neighbours, radius)
      : { point: { lat: round6(p.lat), lng: round6(p.lng) }, snap: undefined };
  const prev = snaps[ring.length - 1];
  const n = s.snap && neighbours.find((x) => x.areaId === s.snap?.areaId);
  const between = prev && s.snap && n ? traceBetween(n.ring, prev, s.snap) : [];
  const last = ring[ring.length - 1];
  if (last && sameCorner(last, s.point))
    return { ring: [...ring], snaps: [...snaps], snap: s.snap };
  return {
    ring: [...ring, ...between, s.point],
    snaps: [...snaps, ...between.map(() => undefined), s.snap],
    snap: s.snap,
  };
}

const sameCorner = (a: Corner, b: Corner) => a.lat === b.lat && a.lng === b.lng;

/** The same corners without one repeated straight after itself (the last and the first too). */
function withoutRepeats(ring: readonly Corner[]): Corner[] {
  const out: Corner[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || !sameCorner(last, p)) out.push(p);
  }
  while (out.length > 1 && sameCorner(out[0] as Corner, out[out.length - 1] as Corner)) out.pop();
  return out;
}

/**
 * "Close the gap with <neighbour>": every corner within `limit` metres of the neighbour moves onto
 * its border (onto its corner when one is within 30 m), and the neighbour's corners in between are
 * added, so the two share that stretch of border exactly. Corners further away stay.
 */
export function closeGap(ring: readonly Corner[], n: Neighbour, limit: number): Corner[] {
  const sign = turn(n.ring);
  const moved = ring.map((p) => {
    let best: { point: Corner; at: number; m: number } | undefined;
    n.ring.forEach((c, i) => {
      const next = n.ring[(i + 1) % n.ring.length];
      if (!next) return;
      const s = ontoSide(p, c, next, sign);
      const m = metres(p, s.point);
      if (m <= limit && (!best || m < best.m)) best = { point: s.point, at: i + s.t, m };
    });
    if (!best) return { point: p, snap: undefined as Snap | undefined };
    const b = best;
    // A neighbour corner near where it lands: take the corner itself.
    const i = n.ring.findIndex((c) => metres(c, b.point) <= SNAP_METRES);
    const c = n.ring[i];
    const snap: Snap = c
      ? { areaId: n.areaId, name: n.name, kind: 'corner', at: i, point: c }
      : { areaId: n.areaId, name: n.name, kind: 'border', at: b.at, point: b.point };
    return { point: snap.point, snap };
  });
  const out: Corner[] = [];
  moved.forEach((m, i) => {
    out.push(m.point);
    const next = moved[(i + 1) % moved.length];
    if (m.snap && next?.snap) out.push(...traceBetween(n.ring, m.snap, next.snap));
  });
  return withoutRepeats(out);
}
