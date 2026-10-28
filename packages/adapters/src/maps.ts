// P1.9.1: street names for the final report's "busiest streets" (hard rule 4: behind an adapter with
// a working fake). The real one (Google Maps, Mapbox, Ola Maps or MapmyIndia) comes with P3.
// P4.4: the rider app's "where am I" map also asks for the roads around a point, to draw its base
// map; the real provider's roads come with the maps account (P6).

/** A road near a point: simplified, as [lat, lng] points; `main` for the bigger roads. */
export interface RoadLine {
  readonly main: boolean;
  readonly points: readonly (readonly [lat: number, lng: number])[];
}

export interface MapsAdapter {
  /** The street at a point, or undefined when none is known there. */
  streetAt(lat: number, lng: number): Promise<string | undefined>;
  /**
   * The roads within about `metres` of a point, simplified, for a small base map (optional: without
   * it the rider's map shows his route and position on a plain ground).
   */
  roadsNear?(lat: number, lng: number, metres: number): Promise<readonly RoadLine[]>;
  /** Credit the road data needs wherever it is shown (e.g. "© OpenStreetMap contributors"). */
  readonly credit?: string;
}

/** Well-known Hyderabad roads, as points along them, for the fake. */
const ROADS: readonly (readonly [name: string, lat: number, lng: number])[] = [
  ['Hitech City Main Road', 17.4474, 78.3762],
  ['Hitech City Main Road', 17.4435, 78.3772],
  ['Madhapur Main Road', 17.4483, 78.3915],
  ['Ayyappa Society Road', 17.4425, 78.3925],
  ['Jubilee Hills Road No. 36', 17.431, 78.407],
  ['Jubilee Hills Road No. 45', 17.429, 78.399],
  ['Banjara Hills Road No. 1', 17.412, 78.448],
  ['Banjara Hills Road No. 12', 17.415, 78.438],
  ['Kondapur Main Road', 17.463, 78.364],
  ['Gachibowli–Miyapur Road', 17.47, 78.359],
  ['Old Mumbai Highway', 17.44, 78.348],
  ['Kukatpally Main Road', 17.485, 78.41],
  ['Ameerpet Main Road', 17.437, 78.448],
  ['Begumpet Road', 17.444, 78.463],
  ['Somajiguda Road', 17.424, 78.46],
  ['Abids Road', 17.392, 78.476],
];

/** Within this distance of a known road point the fake names it; farther, no street. */
const NEAR_M = 1_200;

const metres = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const dy = (lat2 - lat1) * 111_320;
  const dx = (lng2 - lng1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

/** The fake's streets: every 250 m, north–south and east–west (as the simulator's first map). */
const GRID_M = 250;
/** Every fourth one is a main road. */
const MAIN_EVERY = 4;

/**
 * A working fake: the nearest well-known road within 1.2 km, a made-up street grid (every 250 m,
 * every fourth street a main road) for the base map, and a count of the look-ups made.
 */
export function fakeMaps(): MapsAdapter & { readonly calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    roadsNear(lat, lng, metres) {
      calls += 1;
      const r = Math.max(0, Math.min(metres, 5_000));
      const mLat = 111_320;
      const mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
      const lines: RoadLine[] = [];
      // Streets on a fixed grid (the same streets whichever point is asked about).
      const rows = Math.floor((lat * mLat - r) / GRID_M);
      const rowsTo = Math.ceil((lat * mLat + r) / GRID_M);
      for (let i = rows; i <= rowsTo; i++) {
        const y = (i * GRID_M) / mLat;
        lines.push({
          main: i % MAIN_EVERY === 0,
          points: [
            [y, lng - r / mLng],
            [y, lng + r / mLng],
          ],
        });
      }
      const cols = Math.floor((lng * mLng - r) / GRID_M);
      const colsTo = Math.ceil((lng * mLng + r) / GRID_M);
      for (let j = cols; j <= colsTo; j++) {
        const x = (j * GRID_M) / mLng;
        lines.push({
          main: j % MAIN_EVERY === 0,
          points: [
            [lat - r / mLat, x],
            [lat + r / mLat, x],
          ],
        });
      }
      return Promise.resolve(lines);
    },
    streetAt(lat, lng) {
      calls += 1;
      let best: { name: string; d: number } | undefined;
      for (const [name, a, b] of ROADS) {
        const d = metres(lat, lng, a, b);
        if (d <= NEAR_M && (!best || d < best.d)) best = { name, d };
      }
      return Promise.resolve(best?.name);
    },
  };
}
