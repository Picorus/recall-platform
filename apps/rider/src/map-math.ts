// P4.4: drawing the rider's small map. Positions (latitude, longitude) become points on the phone
// (a flat projection around the middle is exact enough for a couple of kilometres), and lines become
// SVG paths. Kept apart from the drawing so it can be tested.
import { segmentHitsBox } from '@recall/domain';

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

const M_PER_DEG = 111_195;

export interface View {
  readonly width: number;
  readonly height: number;
  /** Pixels per metre. */
  readonly scale: number;
  /** A position as [x, y] pixels (y down), from the top left. */
  readonly at: (lat: number, lng: number) => readonly [number, number];
}

/**
 * A view of `width` × `height` pixels centred on `centre`: its longer side shows `metres` across
 * (the roads around him reach about that far), the shorter side proportionally less.
 */
export function viewOf(centre: LatLng, metres: number, width: number, height: number): View {
  const scale = Math.max(width, height) / Math.max(1, metres);
  const kx = M_PER_DEG * Math.cos((centre.lat * Math.PI) / 180);
  return {
    width,
    height,
    scale,
    at: (lat, lng) => [
      width / 2 + (lng - centre.lng) * kx * scale,
      height / 2 - (lat - centre.lat) * M_PER_DEG * scale,
    ],
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * An SVG path through the points ("M x y L x y …"), leaving out pieces wholly off the view (a margin
 * kept) so a long road costs little to draw; "" when nothing of it shows.
 */
export function pathOf(view: View, points: readonly (readonly [number, number])[]): string {
  const m = 40;
  const xy = points.map(([lat, lng]) => view.at(lat, lng));
  let d = '';
  let last = -1;
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1] as readonly [number, number];
    const b = xy[i] as readonly [number, number];
    if (!segmentHitsBox(a[0], a[1], b[0], b[1], -m, -m, view.width + m, view.height + m)) continue;
    if (last !== i - 1) d += `M${r1(a[0])} ${r1(a[1])}`;
    d += `L${r1(b[0])} ${r1(b[1])}`;
    last = i;
  }
  return d;
}

/** "5 min" / "3 h" since `t` (whole minutes or hours; at least 1 minute). */
export function ago(now: number, t: number): { readonly n: number; readonly unit: 'min' | 'h' } {
  const m = Math.max(1, Math.floor((now - t) / 60));
  return m < 60 ? { n: m, unit: 'min' } : { n: Math.floor(m / 60), unit: 'h' };
}
