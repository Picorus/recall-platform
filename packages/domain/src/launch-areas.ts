// P1.1.5: the six launch areas as DRAFT shapes. Simple boxes around each neighbourhood, kept apart so
// they never overlap. Ops correct them on the map (admin → Areas) before anything is sold.
import { createArea, type AreaVersion } from './areas.js';
import type { Ring } from './geo.js';

const box = (south: number, west: number, north: number, east: number): Ring => [
  { lat: south, lng: west },
  { lat: south, lng: east },
  { lat: north, lng: east },
  { lat: north, lng: west },
];

const DRAFTS: readonly { areaId: string; name: string; ring: Ring }[] = [
  { areaId: 'hyd-gachibowli', name: 'Gachibowli', ring: box(17.425, 78.335, 17.448, 78.365) },
  { areaId: 'hyd-kondapur', name: 'Kondapur', ring: box(17.457, 78.345, 17.478, 78.369) },
  { areaId: 'hyd-hitech-city', name: 'Hitech City', ring: box(17.438, 78.371, 17.455, 78.385) },
  { areaId: 'hyd-madhapur', name: 'Madhapur', ring: box(17.438, 78.387, 17.458, 78.402) },
  { areaId: 'hyd-jubilee-hills', name: 'Jubilee Hills', ring: box(17.418, 78.398, 17.436, 78.425) },
  { areaId: 'hyd-banjara-hills', name: 'Banjara Hills', ring: box(17.405, 78.427, 17.425, 78.45) },
];

/** Builds the drafts through the same checks as any saved area, so they can never overlap. */
export function launchAreas(validFrom = '2026-11-01T00:00:00.000Z'): AreaVersion[] {
  const areas: AreaVersion[] = [];
  for (const d of DRAFTS) {
    areas.push(createArea({ ...d, city: 'Hyderabad', validFrom, draft: true }, areas));
  }
  return areas;
}
