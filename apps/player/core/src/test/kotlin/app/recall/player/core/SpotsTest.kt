package app.recall.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals

/** The same shared cases the cloud's scheduler passes (packages/domain/test-vectors/spots.json). */
class SpotsTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "spots.json").readText()).jsonObject

    private fun strings(o: JsonObject, k: String) = o.getValue(k).jsonArray.map { it.jsonPrimitive.content }

    private val plan = v.getValue("plan").jsonObject.let { p ->
        HourPlan(
            p.getValue("areaId").jsonPrimitive.content,
            p.getValue("startsAt").jsonPrimitive.long,
            p.getValue("lines").jsonArray.map { it.jsonObject }.map {
                PlanLine(it.getValue("lineId").jsonPrimitive.content, it.getValue("kind").jsonPrimitive.content, strings(it, "ads"))
            },
            p.getValue("spotDemands").jsonArray.map { it.jsonObject }.map {
                SpotDemand(it.getValue("id").jsonPrimitive.content, it.getValue("kind").jsonPrimitive.content, strings(it, "ads"))
            },
            strings(p, "recallAds"),
        )
    }

    private fun show(c: SpotChoice) = "${c.kind}|${c.id ?: ""}|${c.ad}"

    @Test
    fun `every spot of the hour matches the cloud, for every kind of carry`() {
        val cases = v.getValue("cases").jsonArray.map { it.jsonObject }
        assertEquals(6, cases.size)
        for (c in cases) {
            val carry = c.getValue("carry").jsonObject.let {
                Carry(it["lineId"]?.jsonPrimitive?.takeIf { p -> p.isString }?.content, it["spotId"]?.jsonPrimitive?.takeIf { p -> p.isString }?.content)
            }
            assertEquals(strings(c, "spots"), (0 until 240).map { show(Spots.spotAt(plan, carry, it)) }, carry.toString())
        }
        assertEquals(strings(v, "noRecallAds"), (0 until 12).map { show(Spots.spotAt(plan.copy(recallAds = emptyList()), Carry(null, null), it)) })
    }

    @Test
    fun `an hour is 240 spots, 40 of them RECALL's`() {
        val r = SpotRules()
        assertEquals(240, r.spotsPerHour)
        assertEquals(40, (0 until 240).count(r::isRecallSpot))
        assertEquals(listOf(5, 11, 17), (0 until 18).filter(r::isRecallSpot))
    }
}
