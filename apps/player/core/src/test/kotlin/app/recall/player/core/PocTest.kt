package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** P7.8: the POC rotation and its message: the same shared cases the cloud passes (test-vectors/poc.json). */
class PocTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "poc.json").readText()).jsonObject
    private val okText = v.getValue("ok").jsonObject.getValue("text").jsonPrimitive.content

    private fun strings(o: JsonObject, k: String) = o.getValue(k).jsonArray.map { it.jsonPrimitive.content }
    private fun show(c: SpotChoice) = "${c.kind}|${c.id ?: ""}|${c.ad}"

    @Test
    fun `reads the cloud's message, and refuses what the cloud refuses for the same reason`() {
        val ok = PocPlans.parse(okText)
        assertNull(ok.problem)
        assertEquals(strings(v.getValue("ok").jsonObject, "months"), ok.plans.map { it.month })
        assertEquals(v.getValue("ok").jsonObject.getValue("brands").jsonArray.map { it.jsonPrimitive.int }, ok.plans.map { it.brands.size })
        assertTrue(ok.plans[0].zone is PocZone.Circle)
        assertEquals(PocZone.Areas(listOf("hyd-hitech-city", "hyd-madhapur"), true), ok.plans[1].zone)
        for (r in v.getValue("refused").jsonArray.map { it.jsonObject }) {
            val text = r.getValue("text").jsonPrimitive.content
            assertEquals(r.getValue("problem").jsonPrimitive.content, PocPlans.parse(text).problem, text.take(120))
        }
    }

    @Test
    fun `every spot of the hour matches the cloud, 5 a brand, 40 RECALL spots, the gaps RECALL too`() {
        val rotations = v.getValue("rotations").jsonArray.map { it.jsonObject }
        assertEquals(6, rotations.size)
        for (r in rotations) {
            val p = r.getValue("plan").jsonObject
            val plan = PocPlan(
                "2026-11", 0, 1, PocZone.Areas(listOf("x"), false),
                p.getValue("slots").jsonPrimitive.int, p.getValue("perBrand").jsonPrimitive.int,
                p.getValue("brands").jsonArray.map { it.jsonObject }.map { PocBrand(it.getValue("ref").jsonPrimitive.content, strings(it, "ads")) },
                strings(p, "recallAds"),
            )
            val screen = r.getValue("screenId").jsonPrimitive.content
            val hour = r.getValue("hourStartsAt").jsonPrimitive.long
            assertEquals(r.getValue("offset").jsonPrimitive.int, PocPlans.offset(screen, hour, plan.slots))
            assertEquals(strings(r, "spots"), (0 until 240).map { show(PocPlans.spotAt(plan, screen, hour, it)) }, r.getValue("name").jsonPrimitive.content)
            // Through the hour plan the scheduler hands playback: the same spots.
            val asHour = HourPlan("poc", hour, emptyList(), emptyList(), plan.recallAds, poc = PocCarry(plan, screen))
            assertEquals(strings(r, "spots"), (0 until 240).map { show(Spots.spotAt(asHour, Carry(null, null), it)) })
        }
        val full = rotations[0].getValue("spots").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(40, full.count { it.startsWith("recall|") })
        assertTrue(full.filter { it.startsWith("brand|") }.groupBy { it.split("|")[1] }.values.all { it.size == 5 })
    }

    @Test
    fun `the same offsets, and the same hours covered, as the cloud`() {
        for (o in v.getValue("offsets").jsonArray.map { it.jsonObject })
            assertEquals(
                o.getValue("offset").jsonPrimitive.int,
                PocPlans.offset(o.getValue("screenId").jsonPrimitive.content, o.getValue("hourStartsAt").jsonPrimitive.long, o.getValue("slots").jsonPrimitive.int),
            )
        val plans = PocPlans.parse(okText).plans
        for (c in v.getValue("covers").jsonArray.map { it.jsonObject }) {
            val t = c.getValue("t").jsonPrimitive.long
            assertEquals(c.getValue("november").jsonPrimitive.boolean, PocPlans.covers(plans[0], t), "november $t")
            assertEquals(c.getValue("december").jsonPrimitive.boolean, PocPlans.covers(plans[1], t), "december $t")
        }
    }

    private val dir = Files.createTempDirectory("poc").toFile()
    private val me = "SCR-0123456Z"
    private val plans = PocPlans.parse(okText).plans
    /** 18:00 India time on 2 November 2026, inside November's POC month. */
    private val h18 = plans[0].startsAt + 34 * 3600
    private val near = LatLng(17.455, 78.385)
    private val far = LatLng(17.9, 78.385)

    private fun second(s: LocalScheduler, t: Long, position: LatLng?, place: Place = Place.Outside) =
        s.apply { onSecond(Second(t, FixVerdict.USED, position, place, true, false, true, accuracyM = 5.0)) }

    @Test
    fun `the screen plays the POC rotation in the zone, with no network, and keeps it across a restart`() {
        val s = LocalScheduler(dir, me)
        assertTrue(s.onPoc(okText))
        assertTrue(!s.onPoc(okText), "the same message again changes nothing")
        // Out of the zone: no POC hour (area plans or RECALL's own ads, as before).
        second(s, h18 + 30, far)
        assertNull(s.at((h18 + 30) * 1000))
        second(s, h18 + 60, near)
        val (plan, carry) = assertNotNull(s.at((h18 + 60) * 1000))
        assertEquals("poc", plan.areaId)
        assertEquals(h18, plan.startsAt)
        assertEquals(Carry(null, null), carry)
        assertEquals(show(PocPlans.spotAt(plans[0], me, h18, 4)), show(Spots.spotAt(plan, carry, 4)))
        // At night (03:00) nothing plays for the POC.
        val night = h18 + 9 * 3600
        second(s, night, near)
        assertNull(s.at(night * 1000))
        // A new box on the same storage, with no network: the same plan.
        val again = second(LocalScheduler(dir, me), h18 + 90, near)
        assertEquals(h18, assertNotNull(again.at((h18 + 90) * 1000)).first.startsAt)
        // An older message never replaces a newer one; a broken one is refused and counted.
        assertTrue(!s.onPoc(okText.replace("\"made\":1793620000000", "\"made\":1793610000000")))
        assertTrue(!s.onPoc("{\"v\":1}"))
        assertEquals(1, s.refused)
    }

    @Test
    fun `a month whose zone is areas plays inside them (and at their edge when it says so)`() {
        val s = LocalScheduler(dir, me)
        s.onPoc(okText)
        val dec = plans[1].startsAt + 10 * 3600
        second(s, dec, null, Place.Inside("hyd-madhapur", 3))
        assertNotNull(s.at(dec * 1000))
        second(s, dec + 1, null, Place.Edge("hyd-hitech-city", 1, 40.0))
        assertNotNull(s.at((dec + 1) * 1000))
        second(s, dec + 2, null, Place.Inside("hyd-kondapur", 1))
        assertNull(s.at((dec + 2) * 1000))
    }
}
