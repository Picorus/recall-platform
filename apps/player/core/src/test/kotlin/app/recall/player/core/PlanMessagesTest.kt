package app.recall.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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
import kotlin.test.assertNull

/** The same shared cases the cloud passes (packages/domain/test-vectors/screen-plan.json). */
class PlanMessagesTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "screen-plan.json").readText()).jsonObject
    private val made = v.getValue("made").jsonPrimitive.long
    private fun s(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.content
    private fun l(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.long
    private fun strings(e: JsonElement) = e.jsonArray.map { it.jsonPrimitive.content }
    private fun orNull(e: JsonElement?) = e?.takeIf { it !is JsonNull }?.jsonPrimitive?.content

    private fun expectedPlans() = v.getValue("plans").jsonObject.getValue("parsed").jsonArray.map { it.jsonObject }.map { p ->
        HourPlan(
            s(p, "areaId"), l(p, "startsAt"),
            p.getValue("lines").jsonArray.map { it.jsonObject }.map { PlanLine(s(it, "lineId"), s(it, "kind"), strings(it.getValue("ads")), l(it, "plays"), l(it, "bikes")) },
            p.getValue("spotDemands").jsonArray.map { it.jsonObject }.map { SpotDemand(s(it, "id"), s(it, "kind"), strings(it.getValue("ads")), l(it, "plays")) },
            strings(p.getValue("recallAds")), s(p, "date"), p.getValue("startHour").jsonPrimitive.int, l(p, "revision"),
        )
    }

    @Test
    fun `areas, plans and assignments read exactly as the cloud meant them`() {
        val areas = PlanMessages.areas(s(v.getValue("areas").jsonObject, "text"))
        assertNull(areas.problem)
        assertEquals(made, areas.made)
        val want = v.getValue("areas").jsonObject.getValue("parsed").jsonArray.map { it.jsonObject }.map { a ->
            AreaVersion(
                s(a, "areaId"), a.getValue("version").jsonPrimitive.int,
                a.getValue("ring").jsonArray.map { it.jsonObject }.map { LatLng(it.getValue("lat").jsonPrimitive.double, it.getValue("lng").jsonPrimitive.double) },
                a.getValue("edgeMeters").jsonPrimitive.double, a.getValue("active").jsonPrimitive.boolean,
            )
        }
        assertEquals(want, areas.areas)

        val plans = PlanMessages.plans(s(v.getValue("plans").jsonObject, "text"))
        assertNull(plans.problem)
        assertEquals(made, plans.made)
        assertEquals(expectedPlans(), plans.plans)

        for (a in v.getValue("assign").jsonArray.map { it.jsonObject }) {
            assertEquals(
                Assignment(made, s(a, "areaId"), l(a, "startsAt"), Carry(orNull(a["lineId"]), orNull(a["spotId"]))),
                PlanMessages.assign(s(a, "text")),
            )
        }
    }

    @Test
    fun `refuses the same messages as the cloud, for the same reasons`() {
        for (r in v.getValue("refused").jsonArray.map { it.jsonObject }) {
            val text = s(r, "text")
            val problem = when (s(r, "kind")) {
                "areas" -> PlanMessages.areas(text).problem
                "plan" -> PlanMessages.plans(text).problem
                else -> PlanMessages.assign(text).problem
            }
            assertEquals(s(r, "problem"), problem, text)
        }
    }

    @Test
    fun `the screen own pick matches the cloud, for 200 screens and 4 plans`() {
        for (h in v.getValue("hashes").jsonArray.map { it.jsonObject }) {
            assertEquals(l(h, "fnv1a32"), Fallback.fnv1a32(s(h, "s")), s(h, "s"))
            assertEquals(l(h, "hash32"), Fallback.hash32(s(h, "s")), s(h, "s"))
        }
        val screens = strings(v.getValue("screens"))
        val plans = expectedPlans()
        for (p in v.getValue("picks").jsonArray.map { it.jsonObject }) {
            val plan = plans.single { it.areaId == s(p, "areaId") && it.startsAt == l(p, "startsAt") }
            val want = p.getValue("carries").jsonArray.map { (it as JsonArray).let { c -> Carry(orNull(c[0]), orNull(c[1])) } }
            assertEquals(want, screens.map { Fallback.pick(plan, it) }, plan.areaId + " " + plan.startsAt)
        }
    }
}
