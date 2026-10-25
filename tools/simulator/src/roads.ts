// Roads for the simulator. Version 1 is a regular grid of streets every 250 m over west Hyderabad
// (Gachibowli to Banjara Hills); version 2 rides the real OpenStreetMap roads (road-graph.ts). Both
// are a `RoadMap`: the rest of the simulator only sees "a route is a list of points".
import type { LatLng } from '@recall/domain';
import type { Rng } from './rng.js';

export interface RoadGrid {
  readonly south: number;
  readonly west: number;
  /** Street spacing in metres. */
  readonly spacingM: number;
  /** Number of streets running north–south and east–west. */
  readonly columns: number;
  readonly rows: number;
}

export const WEST_HYDERABAD: RoadGrid = {
  south: 17.4,
  west: 78.33,
  spacingM: 250,
  columns: 57, // 14 km east–west
  rows: 37, // 9 km north–south
};

const M_PER_DEG_LAT = 111_195;

/** A crossing, by column and row. */
export interface Node {
  readonly col: number;
  readonly row: number;
}

export function nodeToLatLng(grid: RoadGrid, n: Node): LatLng {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((grid.south * Math.PI) / 180);
  return {
    lat: grid.south + (n.row * grid.spacingM) / M_PER_DEG_LAT,
    lng: grid.west + (n.col * grid.spacingM) / mPerDegLng,
  };
}

/** The crossing nearest a point (clamped to the grid). */
export function nearestNode(grid: RoadGrid, p: LatLng): Node {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((grid.south * Math.PI) / 180);
  const col = Math.round(((p.lng - grid.west) * mPerDegLng) / grid.spacingM);
  const row = Math.round(((p.lat - grid.south) * M_PER_DEG_LAT) / grid.spacingM);
  return {
    col: Math.min(grid.columns - 1, Math.max(0, col)),
    row: Math.min(grid.rows - 1, Math.max(0, row)),
  };
}

/** Crossings to pass through from `a` to `b` along the streets: east–west first or north–south first. */
export function route(a: Node, b: Node, eastWestFirst: boolean): Node[] {
  const path: Node[] = [a];
  let { col, row } = a;
  const moveCol = () => {
    while (col !== b.col) {
      col += Math.sign(b.col - col);
      path.push({ col, row });
    }
  };
  const moveRow = () => {
    while (row !== b.row) {
      row += Math.sign(b.row - row);
      path.push({ col, row });
    }
  };
  if (eastWestFirst) {
    moveCol();
    moveRow();
  } else {
    moveRow();
    moveCol();
  }
  return path;
}

// ---------------------------------------------------------------- any road map (grid or real roads)

/**
 * What a fake bike needs from a road map. Points are numbered 0 … size − 1; a route is a list of
 * points joined by roads. The grid above and the real OpenStreetMap roads (road-graph.ts) both give
 * one, so the rest of the simulator does not care which it rides on.
 */
export interface RoadMap {
  readonly name: string;
  readonly size: number;
  position(n: number): LatLng;
  /** The point nearest a place. */
  nearest(p: LatLng): number;
  /** Any point, for a bike's start. */
  anyPoint(rng: Rng): number;
  /** A trip's end, about `metres` away from `from` by road (as the crow flies, roughly). */
  tripEnd(from: number, metres: number, rng: Rng): number;
  /** A point close to a place (within about 500 m): for trips to a hotspot. */
  near(p: LatLng, rng: Rng): number;
  /** Points to pass through from `a` to `b`, both included. */
  route(a: number, b: number, rng: Rng): number[];
  /** True where roads meet (a bike may wait at a signal there). */
  isCrossing(n: number): boolean;
}

/** Metres between two nearby points (flat-earth, fine within a city). */
export function metresBetween(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** The street grid as a road map (version 1, kept for quick tests and comparison). */
export function gridMap(grid: RoadGrid = WEST_HYDERABAD): RoadMap {
  const id = (n: Node) => n.row * grid.columns + n.col;
  const node = (i: number): Node => ({ col: i % grid.columns, row: Math.floor(i / grid.columns) });
  const clamp = (n: Node): Node => ({
    col: Math.min(grid.columns - 1, Math.max(0, n.col)),
    row: Math.min(grid.rows - 1, Math.max(0, n.row)),
  });
  return {
    name: 'grid',
    size: grid.columns * grid.rows,
    position: (i) => nodeToLatLng(grid, node(i)),
    nearest: (p) => id(nearestNode(grid, p)),
    anyPoint: (rng) => id({ col: rng.int(0, grid.columns - 1), row: rng.int(0, grid.rows - 1) }),
    tripEnd: (from, metres, rng) => {
      const f = node(from);
      const n = Math.max(1, Math.round(metres / grid.spacingM));
      const east = rng.int(0, n);
      return id(
        clamp({
          col: f.col + (rng.chance(0.5) ? east : -east),
          row: f.row + (rng.chance(0.5) ? n - east : east - n),
        }),
      );
    },
    near: (p, rng) => {
      const h = nearestNode(grid, p);
      return id(clamp({ col: h.col + rng.int(-2, 2), row: h.row + rng.int(-2, 2) }));
    },
    route: (a, b, rng) => route(node(a), node(b), rng.chance(0.5)).map(id),
    isCrossing: () => true,
  };
}
