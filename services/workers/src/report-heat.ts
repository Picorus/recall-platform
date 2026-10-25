// The heat map drawn as hexagons (P1.9.2), shared by the web page and the PDF: each hexagon of plays
// is projected onto a flat box and shaded by how many plays it had.
import { hexOutline, type HeatCell } from '@recall/domain';

export interface DrawnHex {
  /** Corners in the box, y down. */
  readonly points: readonly (readonly [number, number])[];
  /** 0 (fewest plays) … steps − 1 (most). */
  readonly step: number;
  readonly plays: number;
}

/**
 * Projects the hexagons into a `width` × `height` box with a margin, keeping shapes true (one
 * degree of longitude is shorter than one of latitude this far south), and shades them in `steps`.
 */
export function drawHeat(
  cells: readonly HeatCell[],
  width: number,
  height: number,
  steps: number,
): DrawnHex[] {
  if (cells.length === 0) return [];
  const outlines = cells.map((c) => hexOutline(c.cell));
  const all = outlines.flat();
  const lats = all.map(([lat]) => lat);
  const lngs = all.map(([, lng]) => lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const squeeze = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * squeeze, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const margin = 8;
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const most = Math.max(...cells.map((c) => c.plays));
  return cells.map((c, i) => ({
    points: (outlines[i] ?? []).map(
      ([lat, lng]) =>
        [
          Math.round((offX + (lng - minLng) * squeeze * scale) * 10) / 10,
          Math.round((offY + (maxLat - lat) * scale) * 10) / 10,
        ] as const,
    ),
    step: Math.min(steps - 1, Math.floor((c.plays / most) * steps)),
    plays: c.plays,
  }));
}
