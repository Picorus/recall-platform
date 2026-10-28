// P7.8: the POC package on the screen. While the business is on POC, the cloud sends each POC month's
// plan (down/poc: this month and next; the newest message wins, whole): who shares every hour, where
// (the POC zone), and RECALL's own ads. The screen keeps it on storage and builds every hour by
// itself, with no network: brand play k of the hour (0–199) goes to slot (k + offset) mod 40 in 5
// turns, each brand once every 40 brand plays; every sixth spot, and the slots of brands not there,
// are RECALL's. Each play names the brand's month ("poc/<brand>/<YYYY-MM>") and is signed as usual.
//
// The same rules, in the same order, as the cloud's packages/domain/src/poc.ts (pocSpotAt,
// parsePocPlans), checked against the same shared cases (test-vectors/poc.json).
package app.recall.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/** Where a POC month plays: within `radiusM` of a centre, or inside (or at the edge of) areas. */
sealed class PocZone {
    data class Circle(val centre: LatLng, val radiusM: Long) : PocZone()
    data class Areas(val areaIds: List<String>, val withEdge: Boolean) : PocZone()
}

/** A brand of a POC month: what its plays name, and its ads in turn. */
data class PocBrand(val ref: String, val ads: List<String>)

/** A POC month as the screen keeps it. */
data class PocPlan(
    val month: String,
    /** Its business hours, UTC seconds [startsAt, endsAt). */
    val startsAt: Long,
    val endsAt: Long,
    val zone: PocZone,
    /** Brand slots (40) and the plays each gets an hour (5). */
    val slots: Int,
    val perBrand: Int,
    val brands: List<PocBrand>,
    val recallAds: List<String>,
)

/** The POC months' plans (the newest message wins), or why refused. */
data class PocPlanList(val made: Long, val plans: List<PocPlan>, val problem: String? = null)

/** What a bike carries in an hour under a POC month: the rotation, played from this screen's offset. */
data class PocCarry(val plan: PocPlan, val screenId: String)

object PocPlans {
    private val MONTH = Regex("(20\\d{2})-(0[1-9]|1[0-2])")
    private val REF = Regex("poc/([a-z0-9][a-z0-9-]{0,63})/(20\\d{2}-(?:0[1-9]|1[0-2]))")
    private val AD = Regex("[A-Za-z0-9_-]{1,64}")
    private val AREA_ID = Regex("[a-z0-9]+(-[a-z0-9]+)*")
    private val JSON_NUMBER = Regex("-?(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?")
    private const val MAX_SAFE = (1L shl 53) - 1
    const val MAX_PLANS = 3
    const val MAX_SLOTS = 240L

    private class Refused(problem: String) : Exception(problem)

    private fun fail(problem: String): Nothing = throw Refused(problem)

    private fun obj(e: JsonElement?, keys: Set<String>): JsonObject? = (e as? JsonObject)?.takeIf { it.keys == keys }
    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun whole(e: JsonElement?, min: Long, max: Long = MAX_SAFE): Long? {
        val p = (e as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val n = p.content.toBigDecimalOrNull() ?: return null
        return runCatching { n.longValueExact() }.getOrNull()?.takeIf { it in min..max }
    }
    private fun coord(e: JsonElement?, limit: Double): Double? =
        (e as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() && kotlin.math.abs(it) <= limit }
    private fun adList(e: JsonElement?, min: Int, max: Int): List<String>? =
        (e as? JsonArray)?.takeIf { a -> a.size in min..max && a.all { str(it)?.let(AD::matches) == true } }?.mapNotNull(::str)
    private fun strict(e: JsonElement): Boolean = when (e) {
        is JsonObject -> e.values.all(::strict)
        is JsonArray -> e.all(::strict)
        is JsonNull -> true
        is JsonPrimitive -> e.isString || e.content == "true" || e.content == "false" || JSON_NUMBER.matches(e.content)
    }

    /** The month after "YYYY-MM". */
    fun nextMonth(month: String): String {
        val m = MONTH.matchEntire(month) ?: throw IllegalArgumentException("Month must be YYYY-MM")
        val y = m.groupValues[1].toInt()
        val mm = m.groupValues[2].toInt()
        return if (mm == 12) "${y + 1}-01" else "$y-${(mm + 1).toString().padStart(2, '0')}"
    }

    /** A POC month's business hours: 08:00 on the 1st to 02:00 on the next 1st (India time). */
    fun monthWindow(month: String): Pair<Long, Long> =
        PlanMessages.indiaHourStart("$month-01", 8)!! to PlanMessages.indiaHourStart("${nextMonth(month)}-01", 2)!!

    /** A business hour (08:00–02:00 India time)? */
    fun isBusinessHour(t: Long): Boolean {
        val h = Math.floorMod(Math.floorDiv(t + 19_800, 3600L), 24L)
        return h >= 8 || h < 2
    }

    /** Whether a plan plays at `t` (UTC seconds): inside its window, in a business hour. */
    fun covers(p: PocPlan, t: Long): Boolean = t >= p.startsAt && t < p.endsAt && isBusinessHour(t)

    /** First second (UTC) of the India hour holding `t`. */
    fun hourOf(t: Long): Long = Math.floorDiv(t - 1800, 3600L) * 3600 + 1800

    /** Where a bike's rotation starts in an hour (as the cloud's pocOffset). */
    fun offset(screenId: String, hourStartsAt: Long, slots: Int): Int =
        (Fallback.hash32("$screenId|$hourStartsAt") % maxOf(1, slots)).toInt()

    private fun <T> nth(xs: List<T>, i: Int): T? = xs.getOrNull(i % maxOf(1, xs.size))

    /** The ad for spot `index` (0–239) of the hour starting `hourStartsAt` on this screen (the cloud's pocSpotAt). */
    fun spotAt(plan: PocPlan, screenId: String, hourStartsAt: Long, index: Int, rules: SpotRules = SpotRules()): SpotChoice {
        require(index >= 0) { "spot $index: spots count from 0" }
        val recall = SpotChoice("recall", null, nth(plan.recallAds, index) ?: "")
        if (rules.isRecallSpot(index)) return recall
        val group = rules.brandPlaysPerRecallSpot + 1
        val k = index / group * rules.brandPlaysPerRecallSpot + index % group
        val slots = maxOf(1, plan.slots)
        val turn = k / slots
        val offset = offset(screenId, hourStartsAt, slots)
        val b = plan.brands.getOrNull((k + offset) % slots)
        if (turn >= plan.perBrand || b == null) return recall
        val ad = nth(b.ads, turn + offset) ?: return recall
        return SpotChoice("brand", b.ref, ad)
    }

    private fun zone(e: JsonElement?): PocZone {
        val z = e as? JsonObject ?: fail("bad zone")
        return when (str(z["kind"])) {
            "circle" -> {
                obj(z, setOf("kind", "centre", "radiusM")) ?: fail("bad zone")
                val c = obj(z["centre"], setOf("lat", "lng")) ?: fail("bad zone centre")
                val lat = coord(c["lat"], 90.0) ?: fail("bad zone centre")
                val lng = coord(c["lng"], 180.0) ?: fail("bad zone centre")
                val r = whole(z["radiusM"], 1, 1_000_000) ?: fail("bad zone radius")
                PocZone.Circle(LatLng(lat, lng), r)
            }
            "areas" -> {
                obj(z, setOf("kind", "areaIds", "withEdge")) ?: fail("bad zone")
                val ids = (z["areaIds"] as? JsonArray)
                    ?.takeIf { a -> a.size in 1..200 && a.all { str(it)?.let(AREA_ID::matches) == true } }
                    ?.mapNotNull(::str) ?: fail("bad zone areas")
                val edge = (z["withEdge"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: fail("bad zone")
                PocZone.Areas(ids, edge)
            }
            else -> fail("bad zone")
        }
    }

    private fun plan(e: JsonElement): PocPlan {
        val p = obj(e, setOf("month", "startsAt", "endsAt", "zone", "slots", "perBrand", "brands", "recallAds"))
            ?: fail("wrong plan fields")
        val month = str(p["month"])?.takeIf(MONTH::matches) ?: fail("bad month")
        val (start, end) = monthWindow(month)
        // It starts at the month's first business hour; it may end early (the POC switched off).
        whole(p["startsAt"], 1)?.takeIf { it == start } ?: fail("bad start time")
        val endsAt = whole(p["endsAt"], 1)?.takeIf { it > start && it <= end } ?: fail("bad end time")
        val zone = zone(p["zone"])
        val slots = whole(p["slots"], 1, MAX_SLOTS) ?: fail("bad slots")
        val perBrand = whole(p["perBrand"], 1, MAX_SLOTS) ?: fail("bad plays per brand")
        val recallAds = adList(p["recallAds"], 0, 100) ?: fail("bad RECALL ads")
        val list = (p["brands"] as? JsonArray)?.takeIf { it.size <= slots } ?: fail("bad brands")
        val refs = mutableSetOf<String>()
        val brands = list.map { be ->
            val b = obj(be, setOf("ref", "ads")) ?: fail("wrong brand fields")
            val ref = str(b["ref"])
            val r = ref?.let(REF::matchEntire)
            if (ref == null || r == null || r.groupValues[2] != month || !refs.add(ref)) fail("bad brand ref")
            PocBrand(ref, adList(b["ads"], 1, 5) ?: fail("bad brand ads"))
        }
        return PocPlan(month, start, endsAt, zone, slots.toInt(), perBrand.toInt(), brands, recallAds)
    }

    /** Reads the POC plans message as the cloud's parsePocPlans does; a refusal names the same reason. */
    fun parse(text: String): PocPlanList = try {
        if (text.toByteArray().size > PlanMessages.MAX_MESSAGE_BYTES) fail("too big")
        val x = obj(runCatching { Json.parseToJsonElement(text) }.getOrNull()?.takeIf(::strict), setOf("v", "made", "plans"))
            ?: fail("not a POC plans list")
        whole(x["v"], 1, 1) ?: fail("unknown version")
        val made = whole(x["made"], 1) ?: fail("bad list time")
        val list = (x["plans"] as? JsonArray)?.takeIf { it.size <= MAX_PLANS } ?: fail("bad list")
        val plans = list.map(::plan)
        if (plans.map { it.month }.toSet().size != plans.size) fail("a month listed twice")
        PocPlanList(made, plans)
    } catch (e: Refused) {
        PocPlanList(0, emptyList(), e.message)
    }
}
