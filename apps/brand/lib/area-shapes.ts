// P5.4.1: our areas on a map, the parts that need no browser: the shapes as the API gives them,
// each outline drawn in bit by bit, when each area starts drawing, and the words on a tap.

export interface Corner {
  readonly lat: number;
  readonly lng: number;
}

/** An area as GET /portal/areas gives it: the published shape in force now. */
export interface MapArea {
  readonly areaId: string;
  readonly name: string;
  readonly version: number;
  readonly ring: readonly Corner[];
  readonly edgeMeters: number;
  readonly sqKm: number;
}

/** The outline as map points ([lng, lat]), closed: back to the first corner. */
export function closedLine(ring: readonly Corner[]): [number, number][] {
  const first = ring[0];
  return [...ring, ...(first ? [first] : [])].map((p) => [p.lng, p.lat]);
}

const metres = (a: [number, number], b: [number, number]) => {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_195;
};

/**
 * The first `f` (0–1) of the outline, measured along it: what is drawn so far. Always at least
 * the first corner; at 1, the whole closed outline.
 */
export function outlineUpTo(ring: readonly Corner[], f: number): [number, number][] {
  const line = closedLine(ring);
  if (line.length < 2) return line;
  const lengths = line.slice(1).map((p, i) => metres(line[i] ?? p, p));
  const total = lengths.reduce((a, b) => a + b, 0);
  let left = Math.max(0, Math.min(1, f)) * total;
  const out: [number, number][] = [line[0] as [number, number]];
  for (let i = 0; i < lengths.length; i++) {
    const a = line[i] as [number, number];
    const b = line[i + 1] as [number, number];
    const len = lengths[i] ?? 0;
    if (left >= len) {
      out.push(b);
      left -= len;
      continue;
    }
    if (left > 0 && len > 0) {
      const t = left / len;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
    break;
  }
  // A line needs two points.
  if (out.length === 1) out.push(out[0] as [number, number]);
  return out;
}

/** The animation's timings, milliseconds. */
export const DRAW = {
  /** Each area starts this long after the one before it. */
  stagger: 260,
  /** Drawing one outline takes this long… */
  outline: 900,
  /** …then its fill fades in over this long. */
  fill: 500,
} as const;

/** Ease out: fast first, gentle at the end (the design kit's --ease-out, roughly). */
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * How far area `i` is drawn `ms` after the map is ready: its outline (0–1) and its fill (0–1).
 * With reduced motion, everything is there at once.
 */
export function drawnAt(i: number, ms: number, reduced: boolean): { line: number; fill: number } {
  if (reduced) return { line: 1, fill: 1 };
  const t = ms - i * DRAW.stagger;
  const line = easeOut(Math.max(0, Math.min(1, t / DRAW.outline)));
  const fill = easeOut(Math.max(0, Math.min(1, (t - DRAW.outline) / DRAW.fill)));
  return { line, fill };
}

/** Which turn each area takes in the drawing: west to east (then by id), 0 first. */
export function drawOrder(areas: readonly MapArea[]): Map<string, number> {
  const west = (a: MapArea) => Math.min(...a.ring.map((p) => p.lng));
  const sorted = [...areas].sort(
    (a, b) => west(a) - west(b) || (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0),
  );
  return new Map(sorted.map((a, i) => [a.areaId, i]));
}

/** When the last area is fully drawn. */
export const drawingEnds = (areas: number) =>
  Math.max(0, areas - 1) * DRAW.stagger + DRAW.outline + DRAW.fill;

/** "2.4 km²", or "0.62 km²" under one. */
export function sizeText(sqKm: number): string {
  return `${sqKm < 1 ? sqKm.toFixed(2) : sqKm.toFixed(1)} km²`;
}

/** The box around every area, [[west, south], [east, north]], or undefined when there are none. */
export function boundsOf(
  areas: readonly MapArea[],
): [[number, number], [number, number]] | undefined {
  const pts = areas.flatMap((a) => a.ring);
  if (pts.length === 0) return undefined;
  const lngs = pts.map((p) => p.lng);
  const lats = pts.map((p) => p.lat);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

/**
 * The shapes as an SVG path each, fitted into a `width` × `height` box: the drawing used when this
 * computer cannot draw maps (no WebGL), so the areas still show.
 */
export function svgPaths(
  areas: readonly MapArea[],
  width: number,
  height: number,
  pad = 12,
): { areaId: string; d: string }[] {
  const b = boundsOf(areas);
  if (!b) return [];
  const [[w, s], [e, n]] = b;
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const spanX = Math.max(1e-9, (e - w) * k);
  const spanY = Math.max(1e-9, n - s);
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const ox = (width - spanX * scale) / 2;
  const oy = (height - spanY * scale) / 2;
  const at = (p: Corner) =>
    `${(ox + (p.lng - w) * k * scale).toFixed(1)},${(oy + (n - p.lat) * scale).toFixed(1)}`;
  return areas.map((a) => ({
    areaId: a.areaId,
    d: `M${a.ring.map(at).join('L')}Z`,
  }));
}
