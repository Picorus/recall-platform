// Where a rider's moving hours count for pay (Prateek, 22 and 28 Oct 2026), by the business mode in
// force at that second (one setting each):
//  - POC: within 15 km of Hitech City.
//  - Regular business: only inside an area that is on (any of them, not the edge zone); outside
//    every area nothing. A super admin may list areas instead (exceptions).
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
    }
  /** Any area that is on (Prateek, 28 Oct 2026): a new area counts without changing the setting. */
  | { readonly kind: 'allAreas'; readonly withEdge: boolean };

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
  return zone.kind === 'allAreas' || zone.areaIds.includes(place.areaId);
}

/**
 * Regular business (Prateek, 28 Oct 2026): moving hours count only inside an area that is on (not
 * its edge zone); outside every area nothing. Super admins may set listed areas instead.
 */
export const REGULAR_PAY_ZONE: PayZone = { kind: 'allAreas', withEdge: false };

/** The pay zone for a business mode (the POC's circle, or regular business's areas). */
export const zoneForMode = (
  mode: 'poc' | 'regular',
  zones: { readonly pocZone: PayZone; readonly regularZone: PayZone },
): PayZone => (mode === 'poc' ? zones.pocZone : zones.regularZone);

/**
 * Whether a place key from a minute summary ("inside:hyd-madhapur@3", "edge:…@1", "outside")
 * counts in an areas zone; a circle zone cannot be read from a place (undefined).
 */
export function placeKeyInZone(zone: PayZone, key: string): boolean | undefined {
  if (zone.kind === 'circle') return undefined;
  const m = /^(inside|edge):([a-z0-9-]+)@\d+$/.exec(key);
  if (!m) return false;
  if (m[1] === 'edge' && !zone.withEdge) return false;
  return zone.kind === 'allAreas' || zone.areaIds.includes(m[2] ?? '');
}
