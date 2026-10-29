package app.recall.player.core

import java.io.File
import kotlin.math.abs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** P2.8.1: minute summaries and live positions, against the cloud's shared ride (screen-tracker.json). */
class MinutesTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "screen-tracker.json").readText()).jsonObject
    private fun num(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.double

    private val rules = v.getValue("rules").jsonObject.let {
        TrackerRules(
            num(it, "maxAccuracyM"), num(it, "maxSpeedKmh"), it.getValue("jumpResetAfter").jsonPrimitive.int,
            it.getValue("smoothOver").jsonPrimitive.int, it.getValue("areaHoldSeconds").jsonPrimitive.int, num(it, "movingKmh"),
            it.getValue("movingWindowSeconds").jsonPrimitive.long, it.getValue("wakeWindowSeconds").jsonPrimitive.long,
            it.getValue("standbyAfterSeconds").jsonPrimitive.long,
        )
    }

    private val areas = v.getValue("areas").jsonArray.map { it.jsonObject }.map { a ->
        AreaVersion(
            a.getValue("areaId").jsonPrimitive.content,
            a.getValue("version").jsonPrimitive.int,
            a.getValue("ring").jsonArray.map { p -> p.jsonObject.let { LatLng(num(it, "lat"), num(it, "lng")) } },
            num(a, "edgeMeters"),
            a.getValue("active").jsonPrimitive.boolean,
        )
    }

    @Test
    fun `every minute and live position of the shared ride matches the cloud`() {
        val input = v.getValue("input").jsonArray
        val expected = v.getValue("expected").jsonObject
        val t0 = expected.getValue("seconds").jsonArray.first().jsonObject.getValue("t").jsonPrimitive.long
        var state = TrackerState()
        val minutes = Minutes()
        val zone = expected.getValue("zone").jsonObject.let { z ->
            PayZone.Circle(z.getValue("centre").jsonObject.let { LatLng(num(it, "lat"), num(it, "lng")) }, num(z, "radiusM"))
        }
        val small = Minutes(zone)
        // Regular business (P1.7.5): only seconds inside an area that is on count.
        assertEquals(mapOf("kind" to "allAreas", "withEdge" to "false"), expected.getValue("areasZone").jsonObject.mapValues { it.value.jsonPrimitive.content })
        val inAreas = Minutes(PayZone.REGULAR)
        val areasReports = mutableListOf<JsonObject>()
        val reports = mutableListOf<JsonObject>()
        val zoneReports = mutableListOf<JsonObject>()
        input.forEachIndexed { i, raw ->
            val fix = if (raw is JsonNull) null else raw.jsonObject.let { GpsFix(it.getValue("t").jsonPrimitive.long, num(it, "lat"), num(it, "lng"), num(it, "accuracyM")) }
            val (next, s) = Tracker.step(state, t0 + i, fix, areas, rules)
            state = next
            // A play every 15 seconds, as the cloud's generator feeds them.
            val plays = if (i % 15 == 0) 1L else 0L
            reports += minutes.add(s, plays)
            zoneReports += small.add(s, plays)
            areasReports += inAreas.add(s, plays)
        }
        reports += minutes.flush()
        zoneReports += small.flush()
        areasReports += inAreas.flush()
        assertEquals(expected.getValue("areasZoneMinutes").jsonArray.map { it.jsonObject }, areasReports.filter { it.getValue("kind").jsonPrimitive.content == "minute" }, "regular business: inside areas only")
        assertEquals(expected.getValue("zoneMinutes").jsonArray.map { it.jsonObject }, zoneReports.filter { it.getValue("kind").jsonPrimitive.content == "minute" }, "a pay zone the ride leaves")
        val kind = { o: JsonObject -> o.getValue("kind").jsonPrimitive.content }
        val wantMinutes = expected.getValue("minutes").jsonArray.map { it.jsonObject }
        assertEquals(wantMinutes, reports.filter { kind(it) == "minute" })
        val wantLives = expected.getValue("lives").jsonArray.map { it.jsonObject }
        val lives = reports.filter { kind(it) == "live" }
        assertEquals(wantLives.size, lives.size)
        wantLives.zip(lives).forEach { (want, got) ->
            for (k in listOf("t", "place", "moving", "kind")) assertEquals(want[k], got[k], "$k at ${want["t"]}")
            for (k in listOf("lat", "lng")) assertTrue(abs(num(want, k) - num(got, k)) < 1e-9, "$k at ${want["t"]}")
        }
        assertTrue(minutes.flush().isEmpty(), "flushed once")
    }

    @Test
    fun `a minute kept on storage comes back the same`() {
        val m = Minutes()
        val inside = Place.Inside("hyd-madhapur", 1)
        m.add(Second(1_800_000_000, FixVerdict.USED, LatLng(17.45, 78.39), inside, true, false, true), playsNow = 2)
        m.add(Second(1_800_000_001, FixVerdict.USED, LatLng(17.4501, 78.39), inside, true, false, true))
        val kept = assertNotNull(m.snapshot())
        val back = Minutes()
        assertTrue(back.restore(kept))
        val next = Second(1_800_000_002, FixVerdict.USED, LatLng(17.4502, 78.39), inside, true, false, true)
        m.add(next)
        back.add(next)
        assertEquals(m.flush(), back.flush())
        assertFalse(Minutes().restore(JsonObject(emptyMap())), "nothing readable: refused")
    }

    @Test
    fun `the pay clock counts only inside the pay zone, and plays add up per minute`() {
        val inside = Place.Inside("hyd-madhapur", 1)
        val edge = Place.Edge("hyd-madhapur", 1, 100.0)
        val far = LatLng(17.2, 78.6) // about 37 km from Hitech City
        val m = Minutes()
        m.add(Second(1_800_000_000, FixVerdict.USED, LatLng(17.45, 78.39), inside, true, false, true), playsNow = 1)
        m.add(Second(1_800_000_001, FixVerdict.USED, far, inside, true, false, true))
        m.add(Second(1_800_000_002, FixVerdict.NO_FIX, null, inside, false, false, true))
        m.add(Second(1_800_000_003, FixVerdict.NO_FIX, null, Place.Outside, false, true, false), playsNow = 2)
        val r = m.flush().single()
        assertEquals(4L, r.getValue("secondsAt").jsonObject.values.sumOf { it.jsonPrimitive.long })
        assertEquals(3L, r.getValue("clockSeconds").jsonPrimitive.long)
        assertEquals(1L, r.getValue("payClockSeconds").jsonPrimitive.long, "far away, and a gap after it, do not count")
        assertEquals(2L, r.getValue("movingSeconds").jsonPrimitive.long)
        assertEquals(3L, r.getValue("plays").jsonPrimitive.long)

        val many = Minutes()
        many.add(Second(1_800_000_000, FixVerdict.NO_FIX, null, inside, false, false, true), playsNow = 75)
        assertEquals(60L, many.flush().single().getValue("plays").jsonPrimitive.long, "never more than the cloud accepts")

        val areasZone = PayZone.Areas(setOf("hyd-madhapur"), withEdge = false)
        assertTrue(areasZone.counts(null, inside))
        assertFalse(areasZone.counts(null, edge))
        assertTrue(areasZone.copy(withEdge = true).counts(null, edge))
        assertFalse(areasZone.counts(null, Place.Outside))
        assertTrue(PayZone.REGULAR.counts(null, Place.Inside("hyd-kondapur", 2)))
        assertFalse(PayZone.REGULAR.counts(LatLng(17.45, 78.39), edge), "the edge zone does not count")
        assertFalse(PayZone.REGULAR.counts(LatLng(17.45, 78.39), Place.Outside), "outside every area: nothing")
    }
}
