// Where a rider's moving hours count for pay (Prateek, 22 Oct 2026):
//  - POC: within 15 km of Hitech City.
//  - After the POC: inside the areas that are on (Hitech City, Madhapur, Kondapur, Gachibowli,
//    Jubilee Hills, …; more can be added), with exceptions set by a super admin.
// The zone is a setting the cloud sends to every screen; the screen marks each clock second as in or
// out of the zone, so the minute summary says how much of the clock counts.
import type { Place } from './areas.js';
import { distanceMeters, type LatLng } from './geo.js';

export type PayZone =
  | { readonly kind: 'circle'; readonly centre: LatLng; readonly radiusM: number }
  | {
      readonly kind: 'areas';
      /** Area ids whose seconds count (inside, or in their edge zone when `withEdge`). */
      readonly areaIds: readonly string[];
      readonly withEdge: boolean;
    };

/** Cyber Towers, Hitech City. */
export const HITECH_CITY: LatLng = { lat: 17.4504, lng: 78.381 };

export const POC_PAY_ZONE: PayZone = { kind: 'circle', centre: HITECH_CITY, radiusM: 15_000 };

/** True when a clock second at this position and place counts for pay. */
export function inPayZone(zone: PayZone, position: LatLng | undefined, place: Place): boolean {
  if (zone.kind === 'circle') {
    return position !== undefined && distanceMeters(zone.centre, position) <= zone.radiusM;
  }
  if (place.kind === 'outside') return false;
  if (place.kind === 'edge' && !zone.withEdge) return false;
  return zone.areaIds.includes(place.areaId);
}
