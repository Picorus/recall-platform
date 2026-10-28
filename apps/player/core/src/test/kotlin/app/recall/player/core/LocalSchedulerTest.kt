package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LocalSchedulerTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "screen-plan.json").readText()).jsonObject
    private val areasText = v.getValue("areas").jsonObject.getValue("text").jsonPrimitive.content
    private val plansText = v.getValue("plans").jsonObject.getValue("text").jsonPrimitive.content
    private val made = 1_793_620_000_000L
    private val dir = Files.createTempDirectory("schedule").toFile()
    private val me = "SCR-0123456Z"
    /** 18:00 India time on 2 Nov 2026: the first plan's hour (madhapur). */
    private val h18 = 1_793_622_600_000L

    private fun at(s: LocalScheduler, place: Place, t: Long = h18 / 1000 + 60) = s.apply { onSecond(Second(t, FixVerdict.USED, null, place, true, false, true)) }
    private val madhapur = Place.Inside("hyd-madhapur", 3)

    private fun assign(lineId: String?, spotId: String?, made: Long, startsAt: Long = h18 / 1000, area: String = "hyd-madhapur") =
        """{"v":1,"made":$made,"areaId":"$area","startsAt":$startsAt,"lineId":${lineId?.let { "\"$it\"" } ?: "null"},"spotId":${spotId?.let { "\"$it\"" } ?: "null"}}"""

    @Test
    fun `in an area with a plan and no assignment, the screen's own pick, the same the cloud expects`() {
        val s = LocalScheduler(dir, me)
        assertTrue(s.onPlans(plansText))
        assertNull(s.at(h18), "outside every area: no plan")
        assertTrue(s.blankAt(h18), "outside every area: blank (P2.5)")
        at(s, madhapur)
        val (plan, carry) = assertNotNull(s.at(h18 + 60_000))
        assertEquals("hyd-madhapur", plan.areaId)
        assertEquals(h18 / 1000, plan.startsAt)
        assertEquals(Fallback.pick(plan, me), carry)
        // The next hour has its own plan.
        assertEquals(h18 / 1000 + 3600, assertNotNull(s.at(h18 + 3_600_000)).first.startsAt)
        // No plan for that hour: none.
        assertNull(s.at(h18 + 2 * 3_600_000))
    }

    @Test
    fun `outside every area the screen is blank, entering an area it plays that area's plan after the 15 s hold`() {
        val s = LocalScheduler(dir, me)
        assertTrue(s.onAreas(areasText))
        assertTrue(s.onPlans(plansText))
        val playout = Playout(s, { ad -> File("/ads/$ad") })
        var tracker = TrackerState()
        val t0 = h18 / 1000 + 60
        // 20 s standing 550 m south of Madhapur (outside its edge zone), then riding north into it.
        val lats = (0 until 90).map { i -> if (i < 20) 17.435 else minOf(17.447, 17.435 + (i - 19) * 0.00035) }
        var firstInside: Int? = null
        var firstPlan: Int? = null
        lats.forEachIndexed { i, lat ->
            val t = t0 + i
            val (next, second) = Tracker.step(tracker, t, GpsFix(t, lat, 78.39, 5.0), s.areas())
            tracker = next
            s.onSecond(second)
            val raw = second.position?.let { Areas.locate(it, s.areas()) }
            if (firstInside == null && raw is Place.Inside) firstInside = i
            val spot = playout.spotAt(t * 1000)
            if (s.at(t * 1000) == null) {
                assertTrue(s.blankAt(t * 1000), "second $i: outside every area: blank")
                assertTrue(spot.blank && spot.file == null && spot.planned == null, "second $i")
            } else if (firstPlan == null) {
                firstPlan = i
            }
            if (firstPlan != null) {
                assertTrue(!spot.blank, "second $i: in the area")
                assertEquals("hyd-madhapur", spot.areaId)
                assertEquals(Spots.spotAt(assertNotNull(s.at(t * 1000)).first, assertNotNull(s.at(t * 1000)).second, assertNotNull(spot.index)), spot.planned)
            }
        }
        val inside = assertNotNull(firstInside)
        val plan = assertNotNull(firstPlan, "the area's plan plays once the bike is in")
        // The tracker's hold: the new area must be seen 15 seconds (this one and 14 more) first.
        assertEquals(inside + 14, plan)
    }

    @Test
    fun `the cloud's assignment wins for its area-hour, the newest of them, and comes back with the bike`() {
        val s = at(LocalScheduler(dir, me), madhapur)
        s.onPlans(plansText)
        assertTrue(s.onAssign(assign("L-chai", "M-old", made)))
        assertEquals(Carry("L-chai", "M-old"), assertNotNull(s.at(h18)).second)
        assertTrue(!s.onAssign(assign("L-ponnu", null, made - 1)), "an older one is ignored")
        assertTrue(s.onAssign(assign(null, null, made + 1)))
        assertEquals(Carry(null, null), assertNotNull(s.at(h18)).second, "nothing: RECALL's own ads")
        // Out of the area and back: the same again.
        at(s, Place.Outside)
        assertNull(s.at(h18))
        at(s, madhapur)
        assertEquals(Carry(null, null), assertNotNull(s.at(h18)).second)
        // Another hour has no assignment yet: the screen's own pick.
        val next = assertNotNull(s.at(h18 + 3_600_000))
        assertEquals(Fallback.pick(next.first, me), next.second)
    }

    @Test
    fun `a re-sent plan with a higher revision replaces the old, a lower one does not`() {
        val s = at(LocalScheduler(dir, me), madhapur)
        s.onPlans(plansText)
        val first = Json.parseToJsonElement(plansText).jsonObject.getValue("plans").jsonArray[0].jsonObject
        fun resent(revision: Int, line: String) = """{"v":1,"made":${made + 5},"plans":[${first.toString().replace("\"revision\":2", "\"revision\":$revision").replace("L-ponnu", line)}]}"""
        assertTrue(s.onPlans(resent(3, "L-newer")))
        assertTrue(assertNotNull(s.at(h18)).first.lines.any { it.lineId == "L-newer" })
        assertTrue(!s.onPlans(resent(1, "L-older")))
        assertTrue(assertNotNull(s.at(h18)).first.lines.none { it.lineId == "L-older" })
    }

    @Test
    fun `everything is kept across a restart, and ended hours are dropped by the cloud's own time`() {
        val s = at(LocalScheduler(dir, me), madhapur)
        s.onAreas(areasText)
        s.onPlans(plansText)
        s.onAssign(assign("L-big", "G-agg", made))
        val again = at(LocalScheduler(dir, me), madhapur)
        assertEquals(2, again.areas().size)
        assertEquals(Carry("L-big", "G-agg"), assertNotNull(again.at(h18)).second)
        // A message written after 19:00 India time: the 18:00 hour (and its assignment) is over.
        again.onPlans("""{"v":1,"made":${h18 + 3_600_000 + 1_000},"plans":[]}""")
        assertNull(again.at(h18))
        assertNotNull(again.at(h18 + 3_600_000))
        val third = at(LocalScheduler(dir, me), madhapur)
        assertNull(third.at(h18))
        assertNotNull(third.at(h18 + 3_600_000))
    }

    @Test
    fun `in an edge zone the bike carries the area's booking only after being inside it this hour`() {
        val s = LocalScheduler(dir, me)
        s.onPlans(plansText)
        val edge = Place.Edge("hyd-madhapur", 3, 120.0)
        at(s, edge)
        assertNull(s.at(h18 + 60_000), "only near the area: RECALL's own ads")
        at(s, madhapur, t = h18 / 1000 + 120)
        at(s, edge, t = h18 / 1000 + 180)
        assertNotNull(s.at(h18 + 180_000), "was inside: the brand stays while GPS wobbles at the border")
        assertNull(s.at(h18 + 3_600_000 + 60_000), "a new hour: not inside yet")
    }

    @Test
    fun `a bike riding from Madhapur into Kondapur switches to Kondapur's brands, and to RECALL's ads outside both`() {
        val s = LocalScheduler(dir, me)
        s.onPlans(plansText)
        at(s, madhapur)
        assertEquals("hyd-madhapur", assertNotNull(s.at(h18 + 60_000)).first.areaId)
        // Leaving Madhapur: in its edge zone the Madhapur brand stays (no flicker at the border)…
        at(s, Place.Edge("hyd-madhapur", 3, 80.0), t = h18 / 1000 + 120)
        assertEquals("hyd-madhapur", assertNotNull(s.at(h18 + 120_000)).first.areaId)
        // …then inside Kondapur (after the tracker's 15-second hold): Kondapur's plan and brands.
        at(s, Place.Inside("hyd-kondapur", 1), t = h18 / 1000 + 180)
        val (plan, carry) = assertNotNull(s.at(h18 + 180_000))
        assertEquals("hyd-kondapur", plan.areaId)
        assertTrue(plan.lines.any { it.lineId == carry.lineId }, "a Kondapur line, never a Madhapur one")
        // Out of every area: RECALL's own ads.
        at(s, Place.Outside, t = h18 / 1000 + 240)
        assertNull(s.at(h18 + 240_000))
    }

    @Test
    fun `an assignment naming a line or spot the plan here does not know falls back to the screen's own pick for that part`() {
        val s = at(LocalScheduler(dir, me), madhapur)
        s.onPlans(plansText)
        s.onAssign(assign("L-unknown", "M-old", made))
        val (plan, carry) = assertNotNull(s.at(h18))
        assertEquals(Carry(Fallback.pick(plan, me).lineId, "M-old"), carry)
        assertEquals(1L, s.unmatched)
    }

    @Test
    fun `a message dated well ahead of the trusted time is refused and cannot freeze later ones`() {
        val s = at(LocalScheduler(dir, me, nowMs = { made }), madhapur)
        assertTrue(!s.onAreas(areasText.replace("\"made\":$made", "\"made\":${made + 3_600_000}")))
        assertTrue(s.onAreas(areasText))
        s.onPlans(plansText)
        assertTrue(!s.onAssign(assign("L-chai", null, made + 3_600_000)))
        assertTrue(s.onAssign(assign("L-chai", null, made + 60_000)), "a little ahead is fine")
        assertEquals(2L, s.refused)
    }

    @Test
    fun `refused messages are counted and change nothing, and an older area list is ignored`() {
        val s = at(LocalScheduler(dir, me), madhapur)
        s.onPlans(plansText)
        assertTrue(!s.onPlans("nope"))
        assertTrue(!s.onAssign("""{"v":1}"""))
        assertTrue(!s.onAreas("[]"))
        assertEquals(3L, s.refused)
        assertNotNull(s.at(h18))
        assertTrue(s.onAreas(areasText))
        assertTrue(!s.onAreas(areasText.replace("\"made\":$made", "\"made\":${made - 1}")))
        assertEquals(2, s.areas().size)
    }
}
