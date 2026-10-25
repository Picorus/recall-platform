// P2.6 (P1.4.3): what the screen carries when no assignment has come from the cloud. The same formula
// as the cloud's (packages/domain/src/scheduler.ts fallbackPick, rendezvous, hash32), checked against
// the same shared cases (test-vectors/screen-plan.json): every screen picks by itself from its own id
// and the hour, yet over many screens each booking gets bikes in proportion to its weight, with no
// network at all.
package app.recall.player.core

object Fallback {
    /** FNV-1a, 32 bits, over the UTF-16 code units (as the cloud's String.charCodeAt). Unsigned. */
    fun fnv1a32(s: String): Long {
        var h = 0x811c9dc5.toInt()
        for (c in s) {
            h = h xor c.code
            h *= 0x01000193
        }
        return h.toLong() and 0xffffffffL
    }

    /** FNV-1a followed by MurmurHash3's final mix, so similar ids spread evenly. Unsigned. */
    fun hash32(s: String): Long {
        var h = fnv1a32(s).toInt()
        h = h xor (h ushr 16)
        h *= 0x85ebca6b.toInt()
        h = h xor (h ushr 13)
        h *= 0xc2b2ae35.toInt()
        h = h xor (h ushr 16)
        return h.toLong() and 0xffffffffL
    }

    /**
     * Weighted rendezvous hashing: the choice with the smallest −ln(u) / weight, u from a hash of
     * (screen, choice, hour). Ties go to the smaller id. StrictMath gives the same logarithm as the cloud.
     */
    fun rendezvous(screenId: String, hourKey: String, choices: List<Pair<String, Long>>): String? {
        var best: String? = null
        var bestScore = Double.POSITIVE_INFINITY
        for ((id, weight) in choices.sortedWith { a, b -> a.first.compareTo(b.first) }) {
            if (weight <= 0) continue
            val u = (hash32("$screenId|$id|$hourKey") + 0.5) / 4_294_967_296.0
            val score = -StrictMath.log(u) / weight
            if (score < bestScore) {
                best = id
                bestScore = score
            }
        }
        return best
    }

    /**
     * Paid lines, weighted by the bikes sold; make-ups (by plays owed) and trials only when there are
     * no paid lines. RECALL spots: make-ups owed (by plays); aggregator ads only when no make-up is owed.
     */
    fun pick(plan: HourPlan, screenId: String): Carry {
        val hourKey = "${plan.areaId}|${plan.date}|${plan.startHour}"
        fun weighted(kind: String) = plan.lines.filter { it.kind == kind }
            .map { it.lineId to if (kind == "make-up") it.plays else it.bikes }
        fun spots(kind: String) = plan.spotDemands.filter { it.kind == kind }.map { it.id to it.plays }
        fun firstWith(tiers: List<List<Pair<String, Long>>>) = tiers.firstOrNull { t -> t.any { it.second > 0 } } ?: emptyList()
        return Carry(
            rendezvous(screenId, hourKey, firstWith(listOf(weighted("paid"), weighted("make-up"), weighted("trial")))),
            rendezvous(screenId, "$hourKey|spot", firstWith(listOf(spots("make-up"), spots("aggregator")))),
        )
    }
}
