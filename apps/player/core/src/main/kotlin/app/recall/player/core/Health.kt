// P2.11: the box's health, once a minute, through the outbox like everything else (the cloud's
// packages/domain/src/screen-health.ts; shared cases test-vectors/health.json). What the box cannot
// read (no battery link, no LED sending card yet) goes as null, never a made-up number. Counters are
// totals since the app started, so a lost report loses nothing.
package app.recall.player.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What the box reads about itself this minute. */
data class HealthReading(
    val batteryPct: Int? = null,
    val charging: Boolean? = null,
    val batteryC: Int? = null,
    val boxC: Int? = null,
    val freeMb: Long = 0,
    val signalDbm: Int? = null,
    val ledFault: Boolean? = null,
    val tamper: Boolean? = null,
)

/** The box's own counters of things that went wrong, since the app started. */
data class HealthCounters(
    val spotsNotCounted: Long = 0,
    val playsNotStored: Long = 0,
    val messagesRefused: Long = 0,
    val gpsMissedSeconds: Long = 0,
    val adsMissing: Long = 0,
)

object Health {
    private fun n(v: Number?) = if (v == null) JsonNull else JsonPrimitive(v)
    private fun b(v: Boolean?) = if (v == null) JsonNull else JsonPrimitive(v)

    /** The health report for minute `t` (UTC seconds, a whole minute). */
    fun report(t: Long, app: String, upS: Long, r: HealthReading, c: HealthCounters, clockDisagree: Boolean): JsonObject {
        require(Math.floorMod(t, 60L) == 0L) { "health is for a whole minute" }
        // Out of range is no reading (a sensor gone wrong), never a number the cloud refuses.
        return JsonObject(
            linkedMapOf(
                "kind" to JsonPrimitive("health"),
                "t" to JsonPrimitive(t),
                "app" to JsonPrimitive(app),
                "upS" to JsonPrimitive(maxOf(0, upS)),
                "batteryPct" to n(r.batteryPct?.takeIf { it in 0..100 }),
                "charging" to b(r.charging),
                "batteryC" to n(r.batteryC?.takeIf { it in -40..150 }),
                "boxC" to n(r.boxC?.takeIf { it in -40..150 }),
                "freeMb" to JsonPrimitive(r.freeMb.coerceIn(0, 10_000_000)),
                "signalDbm" to n(r.signalDbm?.takeIf { it in -150..0 }),
                "ledFault" to b(r.ledFault),
                "tamper" to b(r.tamper),
                "clockDisagree" to JsonPrimitive(clockDisagree),
                "spotsNotCounted" to JsonPrimitive(c.spotsNotCounted),
                "playsNotStored" to JsonPrimitive(c.playsNotStored),
                "messagesRefused" to JsonPrimitive(c.messagesRefused),
                "gpsMissedSeconds" to JsonPrimitive(c.gpsMissedSeconds),
                "adsMissing" to JsonPrimitive(c.adsMissing),
            ),
        )
    }
}

/** Sends one health report a minute, whenever it is asked (at most once per minute). */
class HealthReporter(
    private val app: String,
    private val read: () -> HealthReading,
    private val counters: () -> HealthCounters,
    private val clockDisagree: () -> Boolean,
    private val send: (JsonObject, Long) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private var lastMinute: Long? = null

    /** `nowS`: trusted time (UTC seconds); `upS`: seconds since the app started. True when one was sent. */
    @Synchronized
    fun tick(nowS: Long, upS: Long): Boolean {
        val minute = nowS - Math.floorMod(nowS, 60L)
        val last = lastMinute
        if (last != null && minute <= last) return false
        lastMinute = minute
        return runCatching {
            val reading = runCatching(read).getOrElse { HealthReading() }
            send(Health.report(minute, app, upS, reading, counters(), clockDisagree()), nowS)
        }.onFailure { log("health: not sent: ${it.javaClass.simpleName}: ${it.message}") }.isSuccess
    }
}
