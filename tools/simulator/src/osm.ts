// P1.10.1 version 2: real roads from OpenStreetMap. An Overpass answer (roads in a box) is turned into
// a small road graph: points (whole 1e-5 degrees, about 1 m) and the road pieces between them, keeping
// only the largest connected part so every trip has a way. The file lives in `data/` with its source
// and licence (© OpenStreetMap contributors, ODbL).

/** The road kinds a delivery bike uses (no footpaths, no private service lanes). */
export const BIKE_ROADS = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
] as const;

export interface Box {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** West Hyderabad, Gachibowli to Banjara Hills, with a margin around the six launch areas. */
export const WEST_HYDERABAD_BOX: Box = { south: 17.38, west: 78.31, north: 17.5, east: 78.48 };

export function overpassQuery(box: Box): string {
  const kinds = BIKE_ROADS.join('|');
  return `[out:json][timeout:300];way["highway"~"^(${kinds})$"](${box.south},${box.west},${box.north},${box.east});(._;>;);out skel qt;`;
}

export interface RoadData {
  readonly source: string;
  readonly licence: string;
  readonly fetchedAt: string;
  readonly box: Box;
  /** Points as [lat, lng, lat, lng, …] in whole 1e-5 degrees. */
  readonly points: readonly number[];
  /** Road pieces as [a, b, a, b, …], point indexes; both ways (bikes go both ways in practice). */
  readonly pieces: readonly number[];
}

interface OverpassElement {
  readonly type: string;
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly nodes?: readonly number[];
}

/** Turns an Overpass answer into road data: the largest connected part only, in a fixed order. */
export function roadsFromOverpass(
  answer: { readonly elements: readonly OverpassElement[] },
  box: Box,
  fetchedAt: string,
): RoadData {
  const where = new Map<number, [number, number]>();
  for (const e of answer.elements)
    if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined)
      where.set(e.id, [Math.round(e.lat * 1e5), Math.round(e.lon * 1e5)]);
  const pairs = new Map<string, [number, number]>();
  for (const e of answer.elements) {
    if (e.type !== 'way' || !e.nodes) continue;
    for (let i = 1; i < e.nodes.length; i++) {
      const a = e.nodes[i - 1];
      const b = e.nodes[i];
      if (a === undefined || b === undefined || a === b || !where.has(a) || !where.has(b)) continue;
      const [x, y] = a < b ? [a, b] : [b, a];
      pairs.set(`${x}|${y}`, [x, y]);
    }
  }
  // Largest connected part (union-find over OSM ids).
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r;
    let y = x;
    while (y !== r) {
      const next = parent.get(y) ?? y;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  for (const [a, b] of pairs.values()) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const size = new Map<number, number>();
  const used = new Set<number>();
  for (const [a, b] of pairs.values()) for (const n of [a, b]) used.add(n);
  for (const n of used) size.set(find(n), (size.get(find(n)) ?? 0) + 1);
  let best = -1;
  let bestSize = 0;
  for (const [root, n] of size)
    if (n > bestSize || (n === bestSize && root < best)) [best, bestSize] = [root, n];
  const keep = [...used].filter((n) => find(n) === best).sort((a, b) => a - b);
  const index = new Map(keep.map((id, i) => [id, i]));
  const points: number[] = [];
  for (const id of keep) points.push(...(where.get(id) ?? [0, 0]));
  const pieces: number[] = [];
  const sorted = [...pairs.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  for (const [a, b] of sorted) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined) pieces.push(i, j);
  }
  return {
    source: 'OpenStreetMap via the Overpass API',
    licence: '© OpenStreetMap contributors, Open Database License (ODbL) 1.0',
    fetchedAt,
    box,
    points,
    pieces,
  };
}
