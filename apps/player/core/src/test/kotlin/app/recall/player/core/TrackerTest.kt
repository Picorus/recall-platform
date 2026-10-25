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
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The same shared cases the cloud's reference tracker passes (packages/domain/test-vectors/screen-tracker.json). */
class TrackerTest {
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
    fun `every second of the shared ride matches the cloud - fix, position, area, moving, standby, clock`() {
        val input = v.getValue("input").jsonArray
        val expected = v.getValue("expected").jsonObject.getValue("seconds").jsonArray.map { it.jsonObject }
        assertEquals(input.size, expected.size)
        val t0 = expected.first().getValue("t").jsonPrimitive.long
        var state = TrackerState()
        input.forEachIndexed { i, raw ->
            val t = t0 + i
            val fix = if (raw is JsonNull) null else raw.jsonObject.let { GpsFix(it.getValue("t").jsonPrimitive.long, num(it, "lat"), num(it, "lng"), num(it, "accuracyM")) }
            val (next, s) = Tracker.step(state, t, fix, areas, rules)
            state = next
            val e = expected[i]
            val at = "second $i"
            assertEquals(e.getValue("t").jsonPrimitive.long, s.t, at)
            assertEquals(e.getValue("fix").jsonPrimitive.content, s.fix.word, at)
            assertEquals(e.getValue("place").jsonPrimitive.content, s.place.key, at)
            assertEquals(e.getValue("moving").jsonPrimitive.boolean, s.moving, at)
            assertEquals(e.getValue("standby").jsonPrimitive.boolean, s.standby, at)
            assertEquals(e.getValue("clockRuns").jsonPrimitive.boolean, s.clockRuns, at)
            val lat = e["lat"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.double
            if (lat == null) {
                assertEquals(null, s.position, at)
            } else {
                // Positions are given to 7 decimals (about 1 cm).
                val p = s.position ?: error("$at: no position, expected one")
                assertTrue(abs(p.lat - lat) < 1e-7 && abs(p.lng - num(e, "lng")) < 1e-7, "$at: $p")
            }
        }
    }

    @Test
    fun `time must move forward, and a fix must be for its own second`() {
        val (s, _) = Tracker.step(TrackerState(), 100, null, areas, rules)
        assertFailsWith<IllegalArgumentException> { Tracker.step(s, 100, null, areas, rules) }
        assertFailsWith<IllegalArgumentException> { Tracker.step(s, 101, GpsFix(99, 17.4, 78.4, 5.0), areas, rules) }
    }

    @Test
    fun `areas that are off do not count, and the nearer edge zone wins`() {
        val a = areas.first()
        val inside = LatLng(a.ring.sumOf { it.lat } / a.ring.size, a.ring.sumOf { it.lng } / a.ring.size)
        assertEquals("inside:${a.areaId}@${a.version}", Areas.locate(inside, areas).key)
        assertEquals("outside", Areas.locate(inside, areas.map { it.copy(active = false) }).key)
        assertEquals("outside", Areas.locate(LatLng(0.0, 0.0), areas).key)
    }
}
