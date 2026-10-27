// The areas drawn as shapes (no map tiles needed): longitude and latitude to picture points, with
// the latitude squeezed as it is on the ground at Hyderabad's latitude.

export type Ring = readonly (readonly [number, number])[];

export function projector(rings: readonly Ring[], width: number, height: number, pad = 8) {
  const pts = rings.flat();
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [
    Math.min(...lngs),
    Math.max(...lngs),
    Math.min(...lats),
    Math.max(...lats),
  ];
  const k = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const w = Math.max((x1 - x0) * k, 1e-9);
  const h = Math.max(y1 - y0, 1e-9);
  const s = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const ox = (width - w * s) / 2;
  const oy = (height - h * s) / 2;
  return (p: readonly [number, number]): [number, number] => [
    ox + (p[0] - x0) * k * s,
    oy + (y1 - p[1]) * s,
  ];
}

/** An SVG path for a ring. */
export function pathOf(ring: Ring, at: (p: readonly [number, number]) => [number, number]): string {
  return `${ring
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'}${at(p)
          .map((n) => n.toFixed(1))
          .join(',')}`,
    )
    .join(' ')} Z`;
}
