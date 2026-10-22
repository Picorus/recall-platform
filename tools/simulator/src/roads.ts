// Roads for the simulator. Version 1 is a regular grid of streets every 250 m over west Hyderabad
// (Gachibowli to Banjara Hills). Real OpenStreetMap roads replace it later (DECISIONS, 22 Oct 2026);
// the rest of the simulator only sees "a route is a list of points", so nothing else changes.
import type { LatLng } from '@recall/domain';

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
