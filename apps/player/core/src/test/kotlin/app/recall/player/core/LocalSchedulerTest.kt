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

    private fun at(s: LocalScheduler, place: Place) = s.apply { onSecond(Second(0, FixVerdict.USED, null, place, true, false, true)) }
    private val madhapur = Place.Inside("hyd-madhapur", 3)

    private fun assign(lineId: String?, spotId: String?, made: Long, startsAt: Long = h18 / 1000, area: String = "hyd-madhapur") =
        """{"v":1,"made":$made,"areaId":"$area","startsAt":$startsAt,"lineId":${lineId?.let { "\"$it\"" } ?: "null"},"spotId":${spotId?.let { "\"$it\"" } ?: "null"}}"""

    @Test
    fun `in an area with a plan and no assignment, the screen's own pick, the same the cloud expects`() {
        val s = LocalScheduler(dir, me)
        assertTrue(s.onPlans(plansText))
        assertNull(s.at(h18), "outside every area: RECALL's own ads")
        at(s, madhapur)
        val (plan, carry) = assertNotNull(s.at(h18 + 60_000))
        assertEquals("hyd-madhapur", plan.areaId)
        assertEquals(h18 / 1000, plan.startsAt)
        assertEquals(Fallback.pick(plan, me), carry)
        // The next hour has its own plan; in an edge zone the area's plan still applies.
        at(s, Place.Edge("hyd-madhapur", 3, 120.0))
        assertEquals(h18 / 1000 + 3600, assertNotNull(s.at(h18 + 3_600_000)).first.startsAt)
        // No plan for that hour: none.
        assertNull(s.at(h18 + 2 * 3_600_000))
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
        fun resent(revision: Int, line: String) = """{"v":1,"made":${made + 5},"plans":[${first.toString().replace("\"revision\":1", "\"revision\":$revision").replace("L-ponnu", line)}]}"""
        assertTrue(s.onPlans(resent(2, "L-newer")))
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
