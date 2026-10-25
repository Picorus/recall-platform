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
        val reports = mutableListOf<JsonObject>()
        input.forEachIndexed { i, raw ->
            val fix = if (raw is JsonNull) null else raw.jsonObject.let { GpsFix(it.getValue("t").jsonPrimitive.long, num(it, "lat"), num(it, "lng"), num(it, "accuracyM")) }
            val (next, s) = Tracker.step(state, t0 + i, fix, areas, rules)
            state = next
            reports += minutes.add(s)
        }
        reports += minutes.flush()
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

        val areasZone = PayZone.Areas(setOf("hyd-madhapur"), withEdge = false)
        assertTrue(areasZone.counts(null, inside))
        assertFalse(areasZone.counts(null, edge))
        assertTrue(areasZone.copy(withEdge = true).counts(null, edge))
        assertFalse(areasZone.counts(null, Place.Outside))
    }
}
