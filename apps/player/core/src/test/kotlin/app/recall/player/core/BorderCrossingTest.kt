package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Review of 29 Oct 2026 (P1.1.7): neighbours share borders, and the screen's held place lags the bike
 * by the 15-second hold. Crossing from Madhapur into its western neighbour, the screen must stop
 * carrying Madhapur's line while the bike is in the neighbour (the cloud would judge those plays
 * "inside another area"): RECALL's own ads until the hold catches up, never a blank screen.
 */
class BorderCrossingTest {
    private val vectors = File(System.getProperty("recall.vectors"))
    private val sp = Json.parseToJsonElement(File(vectors, "screen-plan.json").readText()).jsonObject
    private val plansText = sp.getValue("plans").jsonObject.getValue("text").jsonPrimitive.content
    private val me = "SCR-0123456Z"
    /** 18:00 India time on 2 Nov 2026: the plan's hour for Madhapur. */
    private val h18 = 1_793_622_600L

    /** Madhapur as in the plan's cases, and a neighbour sharing its west border (78.38). */
    private val areasText =
        """{"v":1,"made":1793620000000,"areas":[""" +
            """{"areaId":"hyd-madhapur","version":3,"edgeMeters":300,"active":true,"ring":[[17.44,78.38],[17.44,78.4],[17.455,78.4],[17.455,78.38]]},""" +
            """{"areaId":"hyd-west","version":1,"edgeMeters":300,"active":true,"ring":[[17.44,78.36],[17.44,78.38],[17.455,78.38],[17.455,78.36]]}""" +
            """]}"""
    private val mPerLng = 1 / (111_195 * Math.cos(Math.toRadians(17.447)))

    @Test
    fun `riding from Madhapur into its neighbour, no brand line is played where it would not count`() {
        val s = LocalScheduler(Files.createTempDirectory("cross").toFile(), me)
        assertTrue(s.onAreas(areasText))
        assertTrue(s.onPlans(plansText))
        val playout = Playout(s, { ad -> File("/ads/$ad") })
        var tracker = TrackerState()
        val t0 = h18 + 60
        var lagSeconds = 0
        var carried = 0
        // 500 m inside Madhapur, riding west at 30 km/h for two minutes, into the neighbour.
        for (i in 0 until 120) {
            val t = t0 + i
            val lng = 78.38 + 500 * mPerLng - i * (30 / 3.6) * mPerLng
            val (next, second) = Tracker.step(tracker, t, GpsFix(t, 17.447, lng, 5.0), s.areas())
            tracker = next
            s.onSecond(second)
            val pos = second.position ?: continue
            val atNow = s.at(t * 1000)
            assertTrue(!s.blankAt(t * 1000), "second $i: inside an area, never blank")
            val carry = atNow?.second
            if (carry?.lineId != null) {
                carried++
                val area = assertNotNull(atNow).first.areaId
                assertTrue(Areas.lineCount(pos, area, s.areas()).counts, "second $i: $area's line where it counts")
                assertEquals("hyd-madhapur", area)
            }
            if (second.place.key == "inside:hyd-madhapur@3" && Areas.lineCount(pos, "hyd-madhapur", s.areas()) == Areas.LineCount.INSIDE_ANOTHER) {
                lagSeconds++
                // Madhapur's plan, RECALL's own ads in every spot.
                assertEquals(Carry(null, null), assertNotNull(atNow).second, "second $i")
                // A spot starting now is RECALL's (one started earlier, in Madhapur, is judged there).
                val spot = playout.spotAt(t * 1000)
                assertTrue(!spot.blank, "second $i: $spot")
                if (spot.startUtc == t * 1000) assertEquals("recall", spot.planned?.kind, "second $i: $spot")
            }
        }
        assertTrue(carried > 50, "Madhapur's line played while inside it ($carried s)")
        assertTrue(lagSeconds in 13..15, "the hold: about 14 seconds in the neighbour ($lagSeconds)")
        // After the hold the screen is in the neighbour (no plan there: RECALL's own ads, not blank).
        assertEquals("inside:hyd-west@1", tracker.place.key)
    }

    @Test
    fun `a POC month whose zone is Madhapur stops its rotation in the neighbour too, without blanking`() {
        val poc = Json.parseToJsonElement(File(vectors, "poc.json").readText()).jsonObject
        val okText = poc.getValue("ok").jsonObject.getValue("text").jsonPrimitive.content
        val dec = PocPlans.parse(okText).plans[1]
        assertEquals(PocZone.Areas(listOf("hyd-hitech-city", "hyd-madhapur"), true), dec.zone)
        val s = LocalScheduler(Files.createTempDirectory("cross-poc").toFile(), me)
        assertTrue(s.onAreas(areasText))
        assertTrue(s.onPoc(okText))
        val t = dec.startsAt + 10 * 3600
        val held = Place.Inside("hyd-madhapur", 3)
        // In Madhapur: the POC rotation.
        s.onSecond(Second(t, FixVerdict.USED, LatLng(17.447, 78.39), held, true, false, true, accuracyM = 5.0))
        assertEquals("poc", assertNotNull(s.at(t * 1000)).first.areaId)
        // 100 m into the neighbour, the hold still says Madhapur: RECALL's own ads, not blank.
        s.onSecond(Second(t + 1, FixVerdict.USED, LatLng(17.447, 78.38 - 100 * mPerLng), held, true, false, true, accuracyM = 5.0))
        assertEquals("poc-outside", assertNotNull(s.at((t + 1) * 1000)).first.areaId)
        assertTrue(!s.blankAt((t + 1) * 1000))
        // Within Madhapur's edge zone outside every area (the zone counts its edge): the rotation.
        s.onSecond(Second(t + 2, FixVerdict.USED, LatLng(17.456, 78.39), held, true, false, true, accuracyM = 5.0))
        assertEquals("poc", assertNotNull(s.at((t + 2) * 1000)).first.areaId)
    }
}
