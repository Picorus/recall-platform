// P2.5: which ad fills each 15-second spot of the hour. The same rules as the cloud's scheduler
// (packages/domain/src/scheduler.ts: isRecallSpot, spotAt), checked against the same shared cases
// (test-vectors/spots.json), so the screen and the cloud always agree on what a spot should show.
//
// An hour is 240 spots: after every 5 brand plays comes 1 RECALL spot (200 brand plays, 40 RECALL
// spots, P1.4.5). A bike carries one booking line and plays that brand's 2 to 5 ads in turn; its
// RECALL spots go to the make-up or aggregator ad it carries, else RECALL's own ads.
package app.recall.player.core

/** How an hour on a screen is cut up (settings, from the price book). */
data class SpotRules(val spotSeconds: Int = 15, val brandPlaysPerRecallSpot: Int = 5) {
    init {
        // Hours start on :00 or :30 UTC (India is UTC+5:30): a spot must divide half an hour, so
        // one grid lines up with every hour.
        require(spotSeconds > 0 && 1800 % spotSeconds == 0 && brandPlaysPerRecallSpot > 0)
    }

    val spotsPerHour: Int get() = HOUR_SECONDS / spotSeconds

    /** Spot `index` (0 = first spot of the hour) is a RECALL spot? */
    fun isRecallSpot(index: Int) = index % (brandPlaysPerRecallSpot + 1) == brandPlaysPerRecallSpot

    companion object {
        const val HOUR_SECONDS = 3600
    }
}

/**
 * A booking line in an area-hour, as the screen needs it: the brand's ads, played in turn. `plays`
 * and `bikes` weigh the screen's own pick when no assignment comes (P1.4.3).
 */
data class PlanLine(val lineId: String, val kind: String, val ads: List<String>, val plays: Long = 0, val bikes: Long = 0)

/** Something that fills RECALL's spots: a make-up owed, or an aggregator ad (`plays`: spots wanted). */
data class SpotDemand(val id: String, val kind: String, val ads: List<String>, val plays: Long = 0)

/** The hour plan for one area-hour (P1.4.1), as far as playback needs it. */
data class HourPlan(
    val areaId: String,
    /** First second of the hour, UTC. */
    val startsAt: Long,
    val lines: List<PlanLine>,
    val spotDemands: List<SpotDemand>,
    /** RECALL's own ads: whatever is left. */
    val recallAds: List<String>,
    /** Business date and start hour (24 and 25 are 00:00 and 01:00 after the date): the pick's key. */
    val date: String = "",
    val startHour: Int = 0,
    /** Goes up each time the plan is re-sent (a make-up opened): screens keep the highest. */
    val revision: Long = 1,
    /** P7.8: an hour of a POC month: every brand spot from the rotation (no lines, no demands). */
    val poc: PocCarry? = null,
)

/** What the bike carries in this area-hour: its line, and what fills its RECALL spots (null: RECALL's). */
data class Carry(val lineId: String?, val spotId: String?)

/** What a spot shows: a brand's ad, a make-up or aggregator ad, RECALL's own, or nothing (blank). */
data class SpotChoice(
    /** "brand", "make-up", "aggregator", "recall" or "blank" (outside our zone, P2.5). */
    val kind: String,
    /** The booking line (brand), the make-up or aggregator id; null for RECALL's own. */
    val id: String?,
    /** The ad; "" when the plan has none to give. */
    val ad: String,
) {
    companion object {
        /** Outside our zone (OurZone): a black frame, no file. */
        val BLANK = SpotChoice("blank", null, "")
    }
}

object Spots {
    private fun <T> nth(xs: List<T>, i: Int): T? = xs.getOrNull(i % maxOf(1, xs.size))

    /** The ad for spot `index` of the hour on a bike carrying `carry` (ads take turns). */
    fun spotAt(plan: HourPlan, carry: Carry, index: Int, rules: SpotRules = SpotRules()): SpotChoice {
        require(index >= 0) { "spot $index: spots count from 0" }
        plan.poc?.let { return PocPlans.spotAt(it.plan, it.screenId, plan.startsAt, index, rules) }
        val recall = SpotChoice("recall", null, nth(plan.recallAds, index) ?: "")
        val group = rules.brandPlaysPerRecallSpot + 1
        if (rules.isRecallSpot(index)) {
            val d = plan.spotDemands.firstOrNull { it.id == carry.spotId } ?: return recall
            val ad = nth(d.ads, index / group) ?: return recall
            return SpotChoice(d.kind, d.id, ad)
        }
        val l = plan.lines.firstOrNull { it.lineId == carry.lineId } ?: return recall
        val brandIndex = index / group * rules.brandPlaysPerRecallSpot + index % group
        val ad = nth(l.ads, brandIndex) ?: return recall
        // A spare bike carrying a make-up plays it in its brand spots too, and the play says so.
        return if (l.kind == "make-up") SpotChoice("make-up", l.lineId, ad) else SpotChoice("brand", l.lineId, ad)
    }
}
