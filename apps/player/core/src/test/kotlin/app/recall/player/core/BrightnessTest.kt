package app.recall.player.core

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** P2.10: brightness by the sun and the light around the box. */
class BrightnessTest {
    private val hyd = Sun.HYDERABAD
    private fun utc(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test
    fun `the sun is high at noon, below the horizon at midnight, and rises around 6 in Hyderabad`() {
        // India time is UTC + 5:30.
        assertTrue(Sun.elevation(utc("2026-10-25T06:30:00Z"), hyd) > 50, "noon")
        assertTrue(Sun.elevation(utc("2026-10-25T18:30:00Z"), hyd) < -50, "midnight")
        // Sunrise in Hyderabad on 25 Oct is about 06:12 India time (00:42 UTC), sunset about 17:45 (12:15 UTC).
        assertTrue(Sun.elevation(utc("2026-10-25T00:30:00Z"), hyd) < 0)
        assertTrue(Sun.elevation(utc("2026-10-25T00:55:00Z"), hyd) > 0)
        assertTrue(Sun.elevation(utc("2026-10-25T12:05:00Z"), hyd) > 0)
        assertTrue(Sun.elevation(utc("2026-10-25T12:25:00Z"), hyd) < 0)
        // June: the sun nearly overhead at noon.
        assertTrue(Sun.elevation(utc("2026-06-21T06:52:00Z"), hyd) > 80)
    }

    @Test
    fun `without a sensor - full by day, 30 by night, in between at dusk`() {
        val b = Brightness()
        assertEquals(100, b.target(40.0, null))
        assertEquals(30, b.target(-20.0, null))
        assertEquals(65, b.target(0.0, null))
    }

    @Test
    fun `a sensor is followed, but never too dim by day nor too bright at night`() {
        val b = Brightness()
        assertEquals(60, b.target(40.0, 0.0), "a covered sensor by day: still readable")
        assertEquals(100, b.target(40.0, 50_000.0))
        assertEquals(35, b.target(-20.0, 100_000.0), "a headlight on the sensor at night: never blinding")
        assertEquals(15, b.target(-20.0, 0.5))
        assertTrue(b.target(40.0, 1_000.0) in 61..99)
    }

    @Test
    fun `changes are smooth, and a passing headlight does not count`() {
        val b = Brightness()
        assertEquals(15, b.next(-20.0, 1.0), "first second: straight to the target")
        // Three seconds of a headlight among dark ones: the middle reading stays dark.
        val seen = listOf(1.0, 1.0, 50_000.0, 50_000.0, 50_000.0, 1.0, 1.0).map { b.next(-20.0, it) }
        assertTrue(seen.all { it == 15 }, "$seen")
        // Dawn: the target jumps, the screen climbs 5 points a second.
        val climb = (1..20).map { b.next(40.0, null) }
        assertEquals(listOf(20, 25, 30, 35), climb.take(4))
        assertTrue(climb.zipWithNext().all { (a, c) -> c - a in 0..5 })
        assertEquals(100, climb.last())
    }

    @Test
    fun `a sensor that stops is soon not followed`() {
        val b = Brightness()
        repeat(10) { b.next(40.0, 0.0) }
        assertEquals(60, b.next(40.0, 0.0))
        val after = (1..20).map { b.next(40.0, null) }
        assertEquals(100, after.last(), "no readings: back to the day setting")
    }

    @Test
    fun `settings that could blind or blank are refused`() {
        assertFailsWith<IllegalArgumentException> { BrightnessRules(nightCap = 80) }
        assertFailsWith<IllegalArgumentException> { BrightnessRules(nightFloor = 0) }
        assertFailsWith<IllegalArgumentException> { BrightnessRules(stepPerSecond = 0) }
    }
}
