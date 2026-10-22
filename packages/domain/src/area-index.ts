// P1.1.3: each area pre-computed as H3 hexagons, so "which area is this point in" first looks up one
// hexagon and then checks only the one or two areas that hexagon can belong to.
import {
  getHexagonEdgeLengthAvg,
  gridDisk,
  latLngToCell,
  POLYGON_TO_CELLS_FLAGS,
  polygonToCellsExperimental,
  UNITS,
} from 'h3-js';
import { locate, type AreaVersion, type Place } from './areas.js';
import type { LatLng } from './geo.js';

/** Size 9: hexagons of about 0.1 km² (edge about 200 m). */
export const AREA_CELL_RESOLUTION = 9;

export interface AreaIndex {
  readonly resolution: number;
  /** Hexagon id → areas whose shape or edge zone may reach into it. */
  readonly cells: ReadonlyMap<string, readonly AreaVersion[]>;
}

/** Hexagons touching the area's shape, plus enough rings around them to cover its edge zone. */
export function areaCells(area: AreaVersion, resolution = AREA_CELL_RESOLUTION): Set<string> {
  const shape = polygonToCellsExperimental(
    area.ring.map((p) => [p.lat, p.lng]),
    resolution,
    POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  );
  const rings = Math.ceil(area.edgeMeters / getHexagonEdgeLengthAvg(resolution, UNITS.m)) + 1;
  const cells = new Set<string>();
  for (const cell of shape) for (const near of gridDisk(cell, rings)) cells.add(near);
  return cells;
}

export function buildAreaIndex(
  areas: readonly AreaVersion[],
  resolution = AREA_CELL_RESOLUTION,
): AreaIndex {
  const cells = new Map<string, AreaVersion[]>();
  for (const area of areas) {
    if (!area.active) continue;
    for (const cell of areaCells(area, resolution)) {
      const list = cells.get(cell);
      if (list) list.push(area);
      else cells.set(cell, [area]);
    }
  }
  return { resolution, cells };
}

/** Same answer as `locate(point, allAreas)`, but only checks the areas near the point. */
export function locateIndexed(point: LatLng, index: AreaIndex): Place {
  const candidates = index.cells.get(latLngToCell(point.lat, point.lng, index.resolution));
  return candidates ? locate(point, candidates) : { kind: 'outside' };
}
