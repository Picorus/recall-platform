// P2.5 (Prateek, 28 Oct 2026): outside our zone the screen is blank: a black frame, no file. A blank
// spot is not a play, not a make-up, and not reported; the rider earns no hours there either
// (P1.7.5, pay-zone.ts).
//  - Our zone under a POC month (its business hours): inside the POC zone (15 km of Hitech City).
//  - Otherwise (regular business): inside an area that is on, or in its edge zone (the 10% edge
//    tolerance: a bike that was inside keeps its booking there). Outside every area: blank.
// Inside an area with no booking the screen shows RECALL's own ads, as before.
// The rule lives here only (the screen's copy: apps/player/core/.../OurZone.kt): flip
// BLANK_OUTSIDE_OUR_ZONE to show RECALL's own ads outside our zone again.
import type { Place } from './areas.js';
import type { SpotChoice } from './scheduler.js';

/** True: outside our zone the screen is blank. False: it shows RECALL's own ads there. */
export const BLANK_OUTSIDE_OUR_ZONE = true;

/** What a screen shows in a spot: an ad (SpotChoice), or nothing at all outside our zone. */
export type ScreenSpot = SpotChoice | { readonly kind: 'blank' };

export const BLANK_SPOT: ScreenSpot = { kind: 'blank' };

/** In our zone: under a POC month, inside its zone (`pocInZone`); otherwise inside an area or its edge. */
export const inOurZone = (place: Place, pocInZone: boolean | undefined): boolean =>
  pocInZone ?? place.kind !== 'outside';

/** What a spot shows outside our zone: blank (or, flipped, RECALL's own ad for that spot). */
export function outsideOurZone(recallAds: readonly string[], index: number): ScreenSpot {
  if (BLANK_OUTSIDE_OUR_ZONE) return BLANK_SPOT;
  return { kind: 'recall', ad: recallAds[index % Math.max(1, recallAds.length)] ?? '' };
}
