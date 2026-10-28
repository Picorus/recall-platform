// P2.5 (Prateek, 28 Oct 2026): outside our zone the screen is blank: a black frame, no file. It is
// not a play, not a make-up, and not reported; the rider earns no hours there either (P1.7.5).
//  - Our zone under a POC month (its business hours): inside the POC zone (15 km of Hitech City).
//  - Otherwise (regular business): inside an area that is on, or in its edge zone (the 10% edge
//    tolerance: a bike that was inside keeps its booking there). Outside every area: blank.
// Inside an area with no booking the screen shows RECALL's own ads, as before.
// The rule lives here only (the cloud's copy: packages/domain/src/our-zone.ts): flip BLANK_OUTSIDE to
// show RECALL's own ads outside our zone again.
package app.recall.player.core

object OurZone {
    /** True: outside our zone the screen is blank. False: it shows RECALL's own ads there. */
    const val BLANK_OUTSIDE = true

    /** In our zone: under a POC month, inside its zone (`pocInZone`); else inside an area or its edge zone. */
    fun inside(pocInZone: Boolean?, place: Place): Boolean = pocInZone ?: (place != Place.Outside)

    /** The screen is blank now. */
    fun blank(pocInZone: Boolean?, place: Place): Boolean = BLANK_OUTSIDE && !inside(pocInZone, place)
}
