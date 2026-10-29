// P2.5: what the screen shows in each 15-second spot. Spots follow the clock, not the box: spot n of
// the hour starts exactly at the hour's start + 15 s × n by the trusted time (P2.3.1 TrustedClock),
// so the 200 brand / 40 RECALL pattern holds whatever the box did before (a restart, a slow file).
// The ad comes from the hour plan and what the bike carries (Spots.spotAt, the cloud's own rules).
//
// What is shown is always a whole ad file already on the box and checked (P2.4 AdStore), never a
// stream. When the planned ad's file is not here, a RECALL ad that is here plays instead; the play
// then says so (a RECALL play, not the brand's), so a brand is never counted for a play it did not
// get, and the gap is made up later (P1.6). With no RECALL ad either, the screen shows its slate.
// Without a trusted time the screen still shows RECALL's ads (it never goes dark), but nothing is
// counted: a play needs a time nobody on the bike can change.
// Outside our zone (OurZone, P2.5) the spot is blank: a black frame, no file, never a play.
package app.recall.player.core

import java.io.File

/** The plan and what the bike carries at a time (P2.6, the local scheduler); null: none. */
fun interface PlanSource {
    fun at(utcMs: Long): Pair<HourPlan, Carry>?

    /** Outside our zone at `utcMs`: the screen is blank (OurZone, P2.5). */
    fun blankAt(utcMs: Long): Boolean = false
}

data class Spot(
    /** When the spot starts and ends (UTC ms); null for a spot shown without a trusted time. */
    val startUtc: Long?,
    val endUtc: Long?,
    /** The area and spot of the hour (0–239) the plan was for; null when there was no plan. */
    val areaId: String?,
    val index: Int?,
    /** What the plan wanted; null without a plan. */
    val planned: SpotChoice?,
    /** What is shown; null: the slate (no ad to show). */
    val shows: SpotChoice?,
    val file: File?,
) {
    /** A play by trusted time: the only kind the signed play log (P2.7) records. */
    val timed: Boolean get() = startUtc != null

    /** Outside our zone: a black frame, no file; not a play and not reported (P2.5). */
    val blank: Boolean get() = shows?.kind == SpotChoice.BLANK.kind
}

class Playout(
    private val plans: PlanSource,
    /** The checked file for an ad, or null when it is not on the box (AdStore.file). */
    private val fileOf: (String) -> File?,
    private val rules: SpotRules = SpotRules(),
    private val log: (String) -> Unit = {},
) {
    val spotMs: Long = rules.spotSeconds * 1000L

    /** RECALL's ads from the latest plan seen, for times with no plan or no trusted time. */
    @Volatile private var recallAds: List<String> = emptyList()

    /** The spot that contains `utcMs` (trusted time). */
    fun spotAt(utcMs: Long): Spot {
        // Every hour starts on a whole number of spots (3600 / 15), whatever its minute, so one
        // grid from 1970 lines up with every plan.
        val start = Math.floorDiv(utcMs, spotMs) * spotMs
        val end = start + spotMs
        // Outside our zone: blank (a check that fails is not blank: the screen never goes dark by mistake).
        if (runCatching { plans.blankAt(start) }.getOrDefault(false)) return Spot(start, end, null, null, null, SpotChoice.BLANK, null)
        // A plan that cannot be read, or is off the grid, is no plan: RECALL's ads, never a dark screen.
        val planned = runCatching { plans.at(start) }.onFailure { log("play: no plan: ${it.message}") }.getOrNull()
            ?.takeIf { (plan, _) ->
                (plan.startsAt * 1000 % spotMs == 0L).also { ok -> if (!ok) log("play: plan for ${plan.areaId} is off the spot grid") }
            }
        if (planned != null) {
            val (plan, carry) = planned
            recallAds = plan.recallAds
            val index = ((start - plan.startsAt * 1000) / spotMs).toInt()
            if (start >= plan.startsAt * 1000 && index < rules.spotsPerHour) {
                val choice = Spots.spotAt(plan, carry, index, rules)
                val file = choice.ad.takeIf { it.isNotEmpty() }?.let(fileOf)
                if (file != null) return Spot(start, end, plan.areaId, index, choice, choice, file)
                val (shows, f) = recallHere(plan.recallAds, index)
                return Spot(start, end, plan.areaId, index, choice, shows, f)
            }
        }
        val (shows, f) = recallHere(recallAds, Math.floorDiv(utcMs, spotMs).toInt())
        return Spot(start, end, null, null, null, shows, f)
    }

    /** A spot shown without a trusted time: RECALL's ads in turn (`n`: a running count). */
    fun untimed(n: Int): Spot {
        val (shows, f) = recallHere(recallAds, n)
        return Spot(null, null, null, null, null, shows, f)
    }

    /** RECALL's ad for turn `n`, or the next one that is on the box; null: none is (the slate). */
    private fun recallHere(ads: List<String>, n: Int): Pair<SpotChoice?, File?> {
        for (k in ads.indices) {
            val ad = ads[Math.floorMod(n + k, ads.size)]
            val f = fileOf(ad) ?: continue
            return SpotChoice("recall", null, ad) to f
        }
        return null to null
    }
}
