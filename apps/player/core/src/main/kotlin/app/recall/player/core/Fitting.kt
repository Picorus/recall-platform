// P2.14: the fitting check on the box (the cloud's packages/domain/src/fitting.ts; shared cases
// test-vectors/fitting.json). While the test pattern shows, the box watches for its best GPS fix;
// at the end it reads the line, the camera and the battery and sends a fitting report. The cloud
// judges each part itself: the box only says what it saw. A part it cannot check is "unknown".
package app.recall.player.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What the box can read for a fitting check. */
interface FittingProbes {
    /** Accuracy of the GPS fix this second (m), or null without one. */
    fun gpsAccuracyM(): Double?
    /** The line to the cloud is up. */
    fun lineUp(): Boolean
    /** The camera answers (true), does not (false), or cannot be asked yet (null). */
    fun camera(): Boolean?
    fun batteryPct(): Int?
    fun charging(): Boolean?
}

object Fitting {
    /** The fitting report for command `id`, made at UTC second `atS`, best GPS accuracy `bestGpsM`. */
    fun report(id: String, atS: Long, bestGpsM: Double?, p: FittingProbes): JsonObject {
        fun n(v: Number?) = if (v == null) JsonNull else JsonPrimitive(v)
        fun b(v: Boolean?) = if (v == null) JsonNull else JsonPrimitive(v)
        val camera = when (runCatching { p.camera() }.getOrNull()) {
            true -> "ok"
            false -> "fail"
            null -> "unknown"
        }
        return JsonObject(
            linkedMapOf(
                "kind" to JsonPrimitive("fitting"),
                "id" to JsonPrimitive(id),
                "at" to JsonPrimitive(atS),
                // Rounded up: never a better fix than seen.
                "gpsAccuracyM" to n(bestGpsM?.takeIf { it.isFinite() && it >= 0 }?.let { kotlin.math.ceil(it).toLong().coerceAtMost(100_000) }),
                "lineUp" to JsonPrimitive(runCatching { p.lineUp() }.getOrDefault(false)),
                "camera" to JsonPrimitive(camera),
                "batteryPct" to n(runCatching { p.batteryPct() }.getOrNull()?.takeIf { it in 0..100 }),
                "charging" to b(runCatching { p.charging() }.getOrNull()),
                // The technician confirms the pattern in the rider app (P4); the box cannot see itself.
                "panel" to JsonPrimitive("unknown"),
            ),
        )
    }
}

/** Runs one fitting check: samples GPS each second for `seconds`, then reports. */
class FittingCheck(
    private val probes: FittingProbes,
    /** Waits a second; false when the box is stopping. */
    private val tick: () -> Boolean,
    /** Trusted time now (UTC ms), or null. */
    private val nowMs: () -> Long?,
    private val send: (JsonObject, Long) -> Unit,
) {
    fun run(id: String, seconds: Long) {
        var best: Double? = null
        for (i in 0 until seconds) {
            runCatching { probes.gpsAccuracyM() }.getOrNull()?.let { a ->
                val b = best
                if (b == null || a < b) best = a
            }
            if (!tick()) break
        }
        val atS = Math.floorDiv(nowMs() ?: System.currentTimeMillis(), 1000L)
        send(Fitting.report(id, atS, best, probes), atS)
    }
}
