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
    private fun loop(keep: java.io.File? = null) = GpsLoop({ r, at -> sent += r to at }, { areas }, { seconds += it }, rules, keep = keep)
    private val dir = java.nio.file.Files.createTempDirectory("gps").toFile()
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
            if (i % 15 == 0) g.played()
            g.tick(t0 + i, mono)
        }
        g.flush()
        assertEquals(expected.getValue("minutes").jsonArray.map { it.jsonObject }, kind("minute"))
        val lives = expected.getValue("lives").jsonArray.map { it.jsonObject }
        assertEquals(lives.size, kind("live").size)
        lives.zip(kind("live")).forEach { (want, got) ->
            for (k in listOf("t", "place", "moving")) assertEquals(want[k], got[k])
            for (k in listOf("lat", "lng")) assertTrue(kotlin.math.abs(num(want, k) - num(got, k)) < 1e-9)
        }
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
    fun `a clock pulled far back starts afresh instead of stalling, and saved-up plays are dropped`() {
        val g = loop()
        val t = 1_800_000_000L
        g.tick(t, 0)
        repeat(500) { g.played() } // plays recorded while the clock was wrong
        g.tick(t - 3_600, 1_000) // the cloud's correction: an hour back
        assertEquals(t - 3_600, seconds.last().t, "goes on at once")
        g.tick(t - 3_599, 2_000)
        g.tick(t - 3_600 + 60, 3_000)
        val last = kind("minute").last()
        assertTrue(last.getValue("plays").jsonPrimitive.long <= 60)
        assertEquals(0L, last.getValue("plays").jsonPrimitive.long, "plays from before the jump are not added")
    }

    @Test
    fun `a restart in the same minute goes on, a later one sends the kept minute once`() {
        val keep = java.io.File(dir, "minute")
        val t = 1_800_000_000L - 1_800_000_000L % 60
        val a = loop(keep)
        for (i in 0..25L) a.tick(t + i, i * 1_000)
        // Power cut at t+25: kept at t+20.
        val b = loop(keep)
        b.tick(t + 18, 30_000) // the clock a little behind: waits, no second twice
        b.tick(t + 30, 31_000)
        b.tick(t + 60, 32_000)
        val first = kind("minute").single()
        assertEquals(t, first.getValue("minute").jsonPrimitive.long)
        val total = first.getValue("secondsAt").jsonObject.values.sumOf { it.jsonPrimitive.long }
        assertEquals(60L, total, "0-20 kept, 21-59 stepped after the restart: every second once, none twice")
        // Another restart a minute later: the kept (new) minute goes out finished, once.
        val c = loop(keep)
        c.tick(t + 200, 40_000)
        assertEquals(listOf(t, t + 60), kind("minute").map { it.getValue("minute").jsonPrimitive.long })
        val d = loop(keep)
        d.tick(t + 300, 50_000)
        // The minute c began (t+180) goes out; t and t+60 are never sent again.
        assertEquals(listOf(t, t + 60, t + 180), kind("minute").map { it.getValue("minute").jsonPrimitive.long })
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
