package app.recall.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** P2.11: health reports, against the cloud's shared cases (test-vectors/health.json). */
class HealthTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "health.json").readText()).jsonObject

    private fun intOrNull(o: JsonObject, k: String) = o.getValue(k).takeIf { it !is JsonNull }?.jsonPrimitive?.int
    private fun boolOrNull(o: JsonObject, k: String) = o.getValue(k).takeIf { it !is JsonNull }?.jsonPrimitive?.boolean
    private fun l(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.long

    @Test
    fun `the box builds exactly the reports the cloud expects`() {
        for (c in v.getValue("cases").jsonArray.map { it.jsonObject }) {
            val r = c.getValue("report").jsonObject
            val built = Health.report(
                l(r, "t"), r.getValue("app").jsonPrimitive.content, l(r, "upS"),
                HealthReading(
                    intOrNull(r, "batteryPct"), boolOrNull(r, "charging"), intOrNull(r, "batteryC"), intOrNull(r, "boxC"),
                    l(r, "freeMb"), intOrNull(r, "signalDbm"), boolOrNull(r, "ledFault"), boolOrNull(r, "tamper"),
                ),
                HealthCounters(l(r, "spotsNotCounted"), l(r, "playsNotStored"), l(r, "messagesRefused"), l(r, "gpsMissedSeconds"), l(r, "adsMissing")),
                r.getValue("clockDisagree").jsonPrimitive.boolean,
            )
            assertEquals(r, built, c.getValue("name").jsonPrimitive.content)
        }
    }

    @Test
    fun `a sensor gone wrong is no reading, never a number the cloud refuses`() {
        val r = Health.report(1_800_000_060, "0.9.0", 5, HealthReading(batteryPct = 140, boxC = 900, signalDbm = Int.MAX_VALUE), HealthCounters(), false)
        assertEquals(JsonNull, r["batteryPct"])
        assertEquals(JsonNull, r["boxC"])
        assertEquals(JsonNull, r["signalDbm"])
    }

    @Test
    fun `one report a minute, and a failed reading still reports`() {
        val sent = mutableListOf<Pair<JsonObject, Long>>()
        val h = HealthReporter("0.9.0", { error("battery link down") }, { HealthCounters(adsMissing = 2) }, { false }, { r, at -> sent += r to at })
        assertTrue(h.tick(1_800_000_065, 10))
        assertFalse(h.tick(1_800_000_100, 45), "same minute")
        assertFalse(h.tick(1_800_000_000, 50), "an earlier minute (clock back)")
        assertTrue(h.tick(1_800_000_125, 70))
        assertEquals(listOf(1_800_000_060L, 1_800_000_120L), sent.map { l(it.first, "t") })
        assertEquals(JsonNull, sent[0].first["batteryPct"])
        assertEquals(2L, l(sent[0].first, "adsMissing"))
    }
}
