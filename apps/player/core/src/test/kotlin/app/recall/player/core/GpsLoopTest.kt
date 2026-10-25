package app.recall.player.core

import java.io.File
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
import kotlin.test.assertTrue

/** P2.8.2: the GPS loop, fed like the box feeds it (readings, then a tick each trusted second). */
class GpsLoopTest {
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

    private val sent = mutableListOf<Pair<JsonObject, Long>>()
    private val seconds = mutableListOf<Second>()
    private fun loop() = GpsLoop({ r, at -> sent += r to at }, { areas }, { seconds += it }, rules)
    private fun kind(k: String) = sent.map { it.first }.filter { it.getValue("kind").jsonPrimitive.content == k }

    @Test
    fun `the shared ride, read from a GPS chip second by second, gives the cloud's minutes`() {
        val input = v.getValue("input").jsonArray
        val expected = v.getValue("expected").jsonObject
        val t0 = expected.getValue("seconds").jsonArray.first().jsonObject.getValue("t").jsonPrimitive.long
        val g = loop()
        input.forEachIndexed { i, raw ->
            val mono = 5_000_000L + i * 1_000L
            if (raw !is JsonNull) raw.jsonObject.let { g.onFix(num(it, "lat"), num(it, "lng"), num(it, "accuracyM"), mono - 300) }
            g.tick(t0 + i, mono)
        }
        g.flush()
        assertEquals(expected.getValue("minutes").jsonArray.map { it.jsonObject }, kind("minute"))
        assertEquals(expected.getValue("lives").jsonArray.size, kind("live").size)
        val places = expected.getValue("seconds").jsonArray.map { it.jsonObject.getValue("place").jsonPrimitive.content }
        assertEquals(places, seconds.map { it.place.key }, "the scheduler hears every second")
        assertEquals(0L, g.missedSeconds)
    }

    @Test
    fun `missed seconds are stepped, the clock going back waits, a big jump starts afresh`() {
        val g = loop()
        val t = 1_800_000_000L
        g.tick(t, 0)
        g.tick(t + 3, 3_000) // the box was busy: t+1 and t+2 stepped too
        assertEquals(listOf(t, t + 1, t + 2, t + 3), seconds.map { it.t })
        assertEquals(2L, g.missedSeconds)
        g.tick(t + 2, 4_000) // the clock went back: nothing until it passes t+3
        g.tick(t + 3, 5_000)
        assertEquals(4, seconds.size)
        g.tick(t + 4, 6_000)
        assertEquals(5, seconds.size)
        g.tick(t + 1_000, 7_000) // a correction of 16 minutes: no seconds invented
        assertEquals(6, seconds.size)
        assertEquals(t + 1_000, seconds.last().t)
        assertEquals(1, kind("minute").size, "the minute before the jump went out")
    }

    @Test
    fun `an old reading is no reading, and one reading serves one second`() {
        val g = loop()
        val t = 1_800_000_000L
        g.onFix(17.447, 78.38, 5.0, 0)
        g.tick(t, 2_000) // 2 s old
        assertEquals(FixVerdict.NO_FIX, seconds.last().fix)
        g.onFix(17.447, 78.38, 5.0, 2_500)
        g.tick(t + 1, 3_000)
        assertTrue(seconds.last().fix == FixVerdict.USED || seconds.last().fix == FixVerdict.RESET)
        g.tick(t + 2, 3_200)
        assertEquals(FixVerdict.NO_FIX, seconds.last().fix, "the same reading is not used twice")
        g.onFix(17.447, 78.38, null, 3_300)
        g.tick(t + 3, 3_400)
        assertEquals(FixVerdict.POOR_ACCURACY, seconds.last().fix, "no accuracy given: a poor fix")
    }

    @Test
    fun `plays are added to the minute they are recorded in`() {
        val g = loop()
        val t = 1_800_000_000L - 1_800_000_000L % 60
        g.tick(t, 0)
        g.played()
        g.played()
        g.tick(t + 1, 1_000)
        g.tick(t + 60, 60_000)
        assertEquals(2L, kind("minute").single().getValue("plays").jsonPrimitive.long)
        assertEquals(t, kind("minute").single().getValue("minute").jsonPrimitive.long)
    }
}
