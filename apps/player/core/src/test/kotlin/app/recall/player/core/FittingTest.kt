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

/** P2.14: the fitting check on the box, against the cloud's cases (test-vectors/fitting.json). */
class FittingTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "fitting.json").readText()).jsonObject

    private class Probes(val gps: Double?, val line: Boolean, val cam: Boolean?, val pct: Int?, val chg: Boolean?) : FittingProbes {
        override fun gpsAccuracyM() = gps
        override fun lineUp() = line
        override fun camera() = cam
        override fun batteryPct() = pct
        override fun charging() = chg
    }

    @Test
    fun `the box builds exactly the reports the cloud expects`() {
        for (c in v.getValue("cases").jsonArray.map { it.jsonObject }) {
            val r = c.getValue("report").jsonObject
            fun orNull(k: String) = r.getValue(k).takeIf { it !is JsonNull }?.jsonPrimitive
            val probes = Probes(
                orNull("gpsAccuracyM")?.double,
                r.getValue("lineUp").jsonPrimitive.boolean,
                when (r.getValue("camera").jsonPrimitive.content) { "ok" -> true; "fail" -> false; else -> null },
                orNull("batteryPct")?.int,
                orNull("charging")?.boolean,
            )
            val built = Fitting.report(r.getValue("id").jsonPrimitive.content, r.getValue("at").jsonPrimitive.long, probes.gps, probes)
            assertEquals(r, built, c.getValue("name").jsonPrimitive.content)
        }
    }

    @Test
    fun `the best GPS fix seen during the check is reported, rounded up`() {
        val fixes = ArrayDeque(listOf(null, 40.0, 7.2, 12.0, null))
        var ticks = 0
        val sent = mutableListOf<JsonObject>()
        val probes = object : FittingProbes {
            override fun gpsAccuracyM() = fixes.removeFirstOrNull()
            override fun lineUp() = true
            override fun camera(): Boolean? = error("camera link down")
            override fun batteryPct() = 77
            override fun charging() = false
        }
        FittingCheck(probes, { ticks++; true }, { 1_793_620_000_000 }, { r, _ -> sent += r }).run("c-fitting-0001", 5)
        assertEquals(5, ticks)
        val r = sent.single()
        assertEquals(8L, r.getValue("gpsAccuracyM").jsonPrimitive.long)
        assertEquals("unknown", r.getValue("camera").jsonPrimitive.content, "a probe that fails is not known")
        assertEquals(1_793_620_000L, r.getValue("at").jsonPrimitive.long)
    }
}
