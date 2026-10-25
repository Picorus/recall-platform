// P2.6: reading what the cloud sends to choose what to play: the city's areas (down/areas), the hour
// plans (down/plan) and the live assignment (down/assign). The same rules, in the same order, as the
// cloud's packages/domain/src/screen-plan.ts, checked against the same shared cases
// (test-vectors/screen-plan.json): a message the screen would refuse is never sent, and a refusal names
// the same reason on both sides.
package app.recall.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.doubleOrNull

/** The city's areas in force (`made`: the cloud's ms; the newest list wins), or why refused. */
data class AreaList(val made: Long, val areas: List<AreaVersion>, val problem: String? = null)

/** Hour plans (per area-hour the highest revision wins), or why refused. */
data class PlanList(val made: Long, val plans: List<HourPlan>, val problem: String? = null)

/** The cloud's pick for this screen in one area-hour (per area-hour the newest wins), or why refused. */
data class Assignment(val made: Long, val areaId: String, val startsAt: Long, val carry: Carry, val problem: String? = null)

object PlanMessages {
    private val AREA_ID = Regex("[a-z0-9]+(-[a-z0-9]+)*")
    /** Ads. */
    private val ID = Regex("[A-Za-z0-9_-]{1,64}")
    /** Lines, make-ups and aggregator ids, exactly as plays name them back (P2.7): "booking/area/date/hour", "…#1". */
    private val LINE_ID = Regex("[A-Za-z0-9_#/-]{1,120}")
    private val DATE = Regex("\\d{4}-\\d{2}-\\d{2}")
    /** Plain JSON numbers only (no 1.0f, .5, 01, TRUE): what the cloud's own reader accepts. */
    private val JSON_NUMBER = Regex("-?(0|[1-9]\\d*)(\\.\\d+)?([eE][+-]?\\d+)?")
    private const val HOUR = 3600L
    /** India is UTC+5:30, with no summer time: every hour starts at :30 UTC. */
    private const val IST_OFFSET = 19_800L
    private const val MAX_SAFE = (1L shl 53) - 1
    /** Largest message the screen reads (the broker's own packet limit is 1 MB). */
    const val MAX_MESSAGE_BYTES = 1024 * 1024
    private const val MAX_VERSION = Int.MAX_VALUE.toLong()
    const val MAX_AREAS = 200
    const val MAX_CORNERS = 500
    const val MAX_PLANS = 1000
    const val MAX_LINES = 100
    const val MAX_EDGE = 2000L
    private val LINE_KINDS = setOf("paid", "make-up", "trial")
    private val DEMAND_KINDS = setOf("make-up", "aggregator")

    /** A refusal: `check` failures carry the reason. */
    private class Refused(problem: String) : Exception(problem)

    private fun fail(problem: String): Nothing = throw Refused(problem)
    private fun need(ok: Boolean, problem: String) {
        if (!ok) fail(problem)
    }

    private fun obj(e: JsonElement?, keys: Set<String>): JsonObject? = (e as? JsonObject)?.takeIf { it.keys == keys }
    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    /** A whole number in range, however plain JSON writes it (1, 1.0, 1e3), as the cloud reads it. */
    private fun whole(e: JsonElement?, min: Long, max: Long = MAX_SAFE): Long? {
        val p = (e as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val n = p.content.toBigDecimalOrNull() ?: return null
        return runCatching { n.longValueExact() }.getOrNull()?.takeIf { it in min..max }
    }
    private fun isId(e: JsonElement?) = str(e)?.let(ID::matches) == true
    private fun areaId(e: JsonElement?): String = str(e)?.takeIf(AREA_ID::matches) ?: fail("bad area id")
    private fun idList(e: JsonElement?, min: Int, max: Int): List<String>? =
        (e as? JsonArray)?.takeIf { it.size in min..max && it.all(::isId) }?.mapNotNull(::str)
    private fun coord(e: JsonElement?, limit: Double): Double? =
        (e as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() && kotlin.math.abs(it) <= limit }

    /** Every bare value is plain JSON (true, false, null or a JSON number), as the cloud's reader demands. */
    private fun strict(e: JsonElement): Boolean = when (e) {
        is JsonObject -> e.values.all(::strict)
        is JsonArray -> e.all(::strict)
        is JsonNull -> true
        is JsonPrimitive -> e.isString || e.content == "true" || e.content == "false" || JSON_NUMBER.matches(e.content)
    }

    /** The first second (UTC) of `startHour` on the business date (24 and 25: after midnight); null for a bad date. */
    fun indiaHourStart(date: String, startHour: Long): Long? {
        if (!DATE.matches(date)) return null
        val day = runCatching { java.time.LocalDate.parse(date) }.getOrNull() ?: return null
        return day.toEpochDay() * 86_400 - IST_OFFSET + startHour * HOUR
    }

    /** The list itself: an array of at most `max`. */
    private fun list(e: JsonElement?, max: Int): JsonArray = (e as? JsonArray)?.takeIf { it.size <= max } ?: fail("bad list")

    /** The message, its version and its time; a refusal names the reason. */
    private fun head(text: String, keys: Set<String>, what: String, badTime: String): Pair<JsonObject, Long> {
        need(text.toByteArray().size <= MAX_MESSAGE_BYTES, "too big")
        val x = obj(runCatching { Json.parseToJsonElement(text) }.getOrNull()?.takeIf(::strict), keys) ?: fail(what)
        need(whole(x["v"], 1, 1) != null, "unknown version")
        val made = whole(x["made"], 1) ?: fail(badTime)
        return x to made
    }

    fun areas(text: String): AreaList = try {
        val (x, made) = head(text, setOf("v", "made", "areas"), "not an areas list", "bad list time")
        val areas = list(x["areas"], MAX_AREAS).map { e ->
            val a = obj(e, setOf("areaId", "version", "edgeMeters", "active", "ring")) ?: fail("wrong area fields")
            val id = areaId(a["areaId"])
            val version = whole(a["version"], 1, MAX_VERSION) ?: fail("bad area version")
            val edge = whole(a["edgeMeters"], 0, MAX_EDGE) ?: fail("bad edge zone")
            val active = (a["active"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: fail("bad on/off")
            val ring = (a["ring"] as? JsonArray)?.takeIf { it.size in 3..MAX_CORNERS } ?: fail("bad shape")
            val corners = ring.map { p ->
                val c = (p as? JsonArray)?.takeIf { it.size == 2 } ?: fail("bad corner")
                LatLng(coord(c[0], 90.0) ?: fail("bad corner"), coord(c[1], 180.0) ?: fail("bad corner"))
            }
            AreaVersion(id, version.toInt(), corners, edge.toDouble(), active)
        }
        need(areas.map { it.areaId }.toSet().size == areas.size, "an area listed twice")
        AreaList(made, areas)
    } catch (e: Refused) {
        AreaList(0, emptyList(), e.message)
    }

    fun plans(text: String): PlanList = try {
        val (x, made) = head(text, setOf("v", "made", "plans"), "not a plans list", "bad list time")
        val plans = list(x["plans"], MAX_PLANS).map(::plan)
        need(plans.map { "${it.areaId}|${it.startsAt}" }.toSet().size == plans.size, "an area-hour listed twice")
        PlanList(made, plans)
    } catch (e: Refused) {
        PlanList(0, emptyList(), e.message)
    }

    private fun plan(e: JsonElement): HourPlan {
        val p = obj(e, setOf("areaId", "date", "startHour", "startsAt", "revision", "lines", "spotDemands", "recallAds"))
            ?: fail("wrong plan fields")
        val area = areaId(p["areaId"])
        val date = str(p["date"])?.takeIf(DATE::matches) ?: fail("bad date")
        val startHour = whole(p["startHour"], 0, 25) ?: fail("bad start hour")
        // Exactly the hour its date and start hour name (the screen's own pick is keyed on both).
        val startsAt = whole(p["startsAt"], 1)?.takeIf { it == indiaHourStart(date, startHour) } ?: fail("bad start time")
        val revision = whole(p["revision"], 1) ?: fail("bad revision")
        val recallAds = idList(p["recallAds"], 0, MAX_LINES) ?: fail("bad RECALL ads")
        val ids = mutableSetOf<String>()
        val lines = list(p["lines"], MAX_LINES).map { le ->
            val l = obj(le, setOf("lineId", "kind", "ads", "plays", "bikes")) ?: fail("wrong line fields")
            val id = str(l["lineId"])?.takeIf { LINE_ID.matches(it) && ids.add(it) } ?: fail("bad line id")
            val kind = str(l["kind"])?.takeIf { it in LINE_KINDS } ?: fail("bad line kind")
            val ads = idList(l["ads"], 1, 5) ?: fail("bad line ads")
            val plays = whole(l["plays"], 0)
            val bikes = whole(l["bikes"], 0)
            if (plays == null || bikes == null) fail("bad line numbers")
            PlanLine(id, kind, ads, plays, bikes)
        }
        val demandIds = mutableSetOf<String>()
        val demands = list(p["spotDemands"], MAX_LINES).map { de ->
            val d = obj(de, setOf("id", "kind", "ads", "plays")) ?: fail("wrong spot fields")
            val id = str(d["id"])?.takeIf { LINE_ID.matches(it) && demandIds.add(it) } ?: fail("bad spot id")
            val kind = str(d["kind"])?.takeIf { it in DEMAND_KINDS } ?: fail("bad spot kind")
            val ads = idList(d["ads"], 1, 5) ?: fail("bad spot ads")
            val plays = whole(d["plays"], 0) ?: fail("bad spot plays")
            SpotDemand(id, kind, ads, plays)
        }
        return HourPlan(area, startsAt, lines, demands, recallAds, date, startHour.toInt(), revision)
    }

    /** Plans back to the cloud's text (the screen keeps what it took on storage, read again with `plans`). */
    fun plansText(plans: List<HourPlan>, made: Long): String = buildJsonObject {
        put("v", 1)
        put("made", made)
        putJsonArray("plans") {
            for (p in plans) addJsonObject {
                put("areaId", p.areaId)
                put("date", p.date)
                put("startHour", p.startHour)
                put("startsAt", p.startsAt)
                put("revision", p.revision)
                putJsonArray("lines") {
                    for (l in p.lines) addJsonObject {
                        put("lineId", l.lineId)
                        put("kind", l.kind)
                        putJsonArray("ads") { l.ads.forEach { add(it) } }
                        put("plays", l.plays)
                        put("bikes", l.bikes)
                    }
                }
                putJsonArray("spotDemands") {
                    for (d in p.spotDemands) addJsonObject {
                        put("id", d.id)
                        put("kind", d.kind)
                        putJsonArray("ads") { d.ads.forEach { add(it) } }
                        put("plays", d.plays)
                    }
                }
                putJsonArray("recallAds") { p.recallAds.forEach { add(it) } }
            }
        }
    }.toString()

    fun assign(text: String): Assignment = try {
        val (x, made) = head(text, setOf("v", "made", "areaId", "startsAt", "lineId", "spotId"), "not an assignment", "bad time")
        val area = areaId(x["areaId"])
        val startsAt = whole(x["startsAt"], 1)?.takeIf { it % HOUR == HOUR - IST_OFFSET % HOUR } ?: fail("bad start time")
        fun optionalId(e: JsonElement?, problem: String): String? =
            if (e is JsonNull) null else str(e)?.takeIf(LINE_ID::matches) ?: fail(problem)
        val line = optionalId(x["lineId"], "bad line id")
        val spot = optionalId(x["spotId"], "bad spot id")
        Assignment(made, area, startsAt, Carry(line, spot))
    } catch (e: Refused) {
        Assignment(0, "", 0, Carry(null, null), e.message)
    }
}
