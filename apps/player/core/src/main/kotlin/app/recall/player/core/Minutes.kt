// P2.8.1: what the box tells the cloud about its riding, the box's side of P1.2.4
// (packages/domain/src/screen-reports.ts addSecond / flushMinute; the same shared ride,
// test-vectors/screen-tracker.json):
//  - a live position every 30 seconds (for the fleet map), on seconds with a good fix;
//  - a one-minute summary: seconds at each place, seconds the moving-hour clock ran (and where, and
//    how many inside the pay zone), seconds moving, distance between cleaned positions, plays.
// Rider pay comes from these minutes (moving hours, P1.2.6), so they follow the cloud's rules exactly.
package app.recall.player.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** Where a rider's moving hours count for pay (the cloud's pay-zone.ts). */
sealed interface PayZone {
    /** True when a clock second at this position and place counts for pay. */
    fun counts(position: LatLng?, place: Place): Boolean

    data class Circle(val centre: LatLng, val radiusM: Double) : PayZone {
        override fun counts(position: LatLng?, place: Place) = position != null && Geo.distanceMeters(centre, position) <= radiusM
    }

    data class Areas(val areaIds: Set<String>, val withEdge: Boolean) : PayZone {
        override fun counts(position: LatLng?, place: Place) = when (place) {
            Place.Outside -> false
            is Place.Edge -> withEdge && place.areaId in areaIds
            is Place.Inside -> place.areaId in areaIds
        }
    }

    companion object {
        /** POC: within 15 km of Hitech City (Cyber Towers). */
        val POC = Circle(LatLng(17.4504, 78.381), 15_000.0)
    }
}

/** Builds the minute summaries and live positions from the tracker's seconds. Not thread-safe. */
class Minutes(private val zone: PayZone = PayZone.POC) {
    private var minute: Long? = null
    private var secondsAt = LinkedHashMap<String, Long>()
    private var clockSeconds = 0L
    private var clockAt = LinkedHashMap<String, Long>()
    private var payClockSeconds = 0L
    private var movingSeconds = 0L
    private var distance = 0.0
    private var plays = 0L
    private var people = 0L
    /** The last cleaned position and its second, to measure distance from (kept across minutes). */
    private var last: Pair<LatLng, Long>? = null

    /** Adds one tracker second; returns the reports due now (a finished minute, a live position). */
    fun add(s: Second, playsNow: Long = 0, peopleNow: Long = 0): List<JsonObject> {
        val reports = mutableListOf<JsonObject>()
        val m = s.t - Math.floorMod(s.t, 60L)
        if (minute != m) {
            close()?.let(reports::add)
            minute = m
            secondsAt = LinkedHashMap()
            clockSeconds = 0
            clockAt = LinkedHashMap()
            payClockSeconds = 0
            movingSeconds = 0
            distance = 0.0
            plays = 0
            people = 0
        }
        val key = s.place.key
        val p = s.position
        if (p != null) {
            // No distance across a GPS gap or a reset: the straight line between would be a guess.
            val before = last
            if (before != null && s.t - before.second <= MAX_DISTANCE_GAP_SECONDS && s.fix != FixVerdict.RESET) {
                distance += Geo.distanceMeters(before.first, p)
            }
            last = p to s.t
        }
        secondsAt.merge(key, 1, Long::plus)
        if (s.clockRuns) {
            clockSeconds++
            clockAt.merge(key, 1, Long::plus)
            // Without a fix this second, the last known position decides (a short GPS gap).
            if (zone.counts(p ?: last?.first, s.place)) payClockSeconds++
        }
        if (s.moving) movingSeconds++
        plays += playsNow
        people += peopleNow
        if (Math.floorMod(s.t, LIVE_EVERY_SECONDS) == 0L && p != null) {
            reports += buildJsonObject {
                put("kind", "live")
                put("t", s.t)
                put("lat", p.lat)
                put("lng", p.lng)
                put("place", key)
                put("moving", s.moving)
            }
        }
        return reports
    }

    /** The minute in progress, closed (at shutdown); nothing when there is none. */
    fun flush(): List<JsonObject> = listOfNotNull(close()).also { minute = null }

    private fun close(): JsonObject? {
        val m = minute ?: return null
        return buildJsonObject {
            put("kind", "minute")
            put("minute", m)
            putJsonObject("secondsAt") { secondsAt.forEach { (k, v) -> put(k, v) } }
            put("clockSeconds", clockSeconds)
            putJsonObject("clockAt") { clockAt.forEach { (k, v) -> put(k, v) } }
            put("payClockSeconds", payClockSeconds)
            put("movingSeconds", movingSeconds)
            put("distanceM", Math.round(distance))
            put("plays", plays)
            put("people", people)
        }
    }

    companion object {
        const val LIVE_EVERY_SECONDS = 30L
        /** Distance is only added between positions at most this many seconds apart. */
        const val MAX_DISTANCE_GAP_SECONDS = 10L
    }
}
