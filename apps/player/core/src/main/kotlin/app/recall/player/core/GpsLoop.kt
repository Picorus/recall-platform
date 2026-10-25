// P2.8.2: the GPS service's heart. Once a second by the trusted time, the latest GPS reading is cleaned
// and smoothed (Tracker, P2.6.1: poor fixes and jumps dropped, the area held 15 seconds, the
// moving-hour stopwatch and the 10-minute stop rule), the area goes to the local scheduler (what to
// play, and where each play happened, P2.6/P2.7), and the minute summaries and live positions go to
// the outbox (Minutes, P2.8.1).
//
// Seconds are numbered by the trusted clock, the same clock plays are timed by (review P2.7), never
// by the GPS chip's own stamp. A reading is used only for the second it was taken in (within 1.5 s):
// an old reading is no reading. Seconds the box missed (it was busy) are stepped without a fix, so
// the stopwatch and the minutes stay whole. A jump of the clock by more than 2 minutes either way (a
// correction from the cloud after a wrong GPS time) starts the tracker afresh rather than invent the
// seconds between or stall until the clock catches up; a small step back waits, so no second is ever
// counted twice (review P2.8).
//
// The minute in progress is kept on storage every 10 seconds: the box loses power whenever the bike
// is switched off, and a rider must not lose up to a minute of pay each time. After a restart it goes
// on (the same minute) or is sent finished (an earlier one).
package app.recall.player.core

import java.io.File
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

class GpsLoop(
    /** A report for the cloud (minute summary or live position), made at UTC second `at`. */
    private val send: (JsonObject, Long) -> Unit,
    /** The areas in force (the local scheduler's). */
    private val areas: () -> List<AreaVersion>,
    /** What the tracker settled on, each second (the local scheduler's onSecond). */
    private val onSecond: (Second) -> Unit,
    private val rules: TrackerRules = TrackerRules(),
    private val minutes: Minutes = Minutes(),
    /** Where the minute in progress is kept (null: not kept, tests). */
    private val keep: File? = null,
    private val log: (String) -> Unit = {},
) {
    private class Reading(val lat: Double, val lng: Double, val accuracyM: Double, val monoMs: Long)

    private var state = TrackerState()
    private var last: Long? = null
    private var restored = false
    private val reading = AtomicReference<Reading?>(null)
    private val plays = AtomicLong()
    private val skipped = AtomicLong()

    /** Seconds the box had to step without looking (it fell behind). Health, P2.11. */
    val missedSeconds: Long get() = skipped.get()

    /** The accuracy of the latest reading (m), if it was taken within `withinMs` of `nowMono` (P2.14). */
    fun freshAccuracyM(nowMono: Long, withinMs: Long = 2_000): Double? =
        lastReading?.takeIf { nowMono - it.monoMs in 0..withinMs }?.accuracyM?.takeIf { it != Double.MAX_VALUE }

    @Volatile private var lastReading: Reading? = null

    /** A reading from the GPS chip, taken at the box's counter `monoMs` (any thread). */
    fun onFix(lat: Double, lng: Double, accuracyM: Double?, monoMs: Long) {
        // No accuracy given: treated as a poor fix (the tracker drops it).
        val r = Reading(lat, lng, accuracyM?.takeIf { it.isFinite() && it >= 0 } ?: Double.MAX_VALUE, monoMs)
        reading.set(r)
        lastReading = r
    }

    /** A play was recorded (any thread): counted in the minute it is recorded in. */
    fun played() {
        plays.incrementAndGet()
    }

    /** The second `t` (UTC, trusted clock) has begun, at the box's counter `monoMs`. */
    @Synchronized
    fun tick(t: Long, monoMs: Long) {
        if (!restored) restore(t)
        val before = last
        if (before != null && t <= before && before - t <= MAX_FILL_SECONDS) return
        val from = if (before == null || t - before > MAX_FILL_SECONDS || t < before) {
            if (before != null) {
                log("gps: the clock jumped ${t - before} s: tracker started afresh")
                val done = minutes.flush()
                save(before)
                done.forEach { out(it, before) }
                state = TrackerState()
                plays.set(0)
            }
            t
        } else {
            before + 1
        }
        if (t > from) skipped.addAndGet(t - from)
        for (s in from..t) {
            var r: Reading? = null
            if (s == t) {
                val now = reading.get()
                // One reading, one second: taken only if nobody replaced it meanwhile.
                if (now != null && monoMs - now.monoMs in 0..FRESH_MS && reading.compareAndSet(now, null)) r = now
            }
            val fix = r?.let { GpsFix(s, it.lat, it.lng, it.accuracyM) }
            val (next, second) = Tracker.step(state, s, fix, areas(), rules)
            state = next
            runCatching { onSecond(second) }.onFailure { log("gps: area not passed on: ${it.message}") }
            val due = minutes.add(second, playsNow = if (s == t) plays.getAndSet(0) else 0)
            // Kept before a finished minute goes out: a power cut in between loses it, never sends it twice.
            if (due.any { it["kind"] == KIND_MINUTE } || Math.floorMod(s, SAVE_EVERY_SECONDS) == 0L) save(s)
            due.forEach { out(it, s) }
        }
        last = t
    }

    /** At shutdown: the minute in progress goes out. */
    @Synchronized
    fun flush() {
        val at = last ?: return
        val done = minutes.flush()
        save(at)
        done.forEach { out(it, at) }
    }

    /** After a restart: the kept minute goes on (the same minute) or goes out finished (an earlier one). */
    private fun restore(t: Long) {
        restored = true
        val f = keep ?: return
        val x = runCatching { Json.parseToJsonElement(f.readText()).jsonObject }.getOrNull() ?: return
        val savedAt = x["at"]?.jsonPrimitive?.long ?: return
        val m = (x["minute"] as? JsonObject)?.takeIf { it.isNotEmpty() } ?: return // nothing in progress
        if (!minutes.restore(m)) return log("gps: kept minute could not be read")
        val current = minutes.current ?: return
        if (current == t - Math.floorMod(t, 60L)) {
            last = savedAt // goes on after the last second kept: none twice
        } else {
            val done = minutes.flush()
            save(savedAt)
            done.forEach { out(it, savedAt) }
        }
    }

    private fun save(at: Long) {
        val f = keep ?: return
        runCatching {
            val m = minutes.snapshot()
            DiskFiles.writeAtomically(f, JsonObject(mapOf("at" to JsonPrimitive(at), "minute" to (m ?: JsonObject(emptyMap())))).toString())
        }.onFailure { log("gps: minute not kept: ${it.javaClass.simpleName}") }
    }

    private fun out(report: JsonObject, at: Long) {
        runCatching { send(report, at) }.onFailure { log("gps: report not stored: ${it.javaClass.simpleName}: ${it.message}") }
    }

    companion object {
        /** A reading this old (ms) when its second begins is no reading. */
        const val FRESH_MS = 1_500L
        /** Missed seconds up to this are stepped without a fix; a bigger jump starts afresh. */
        const val MAX_FILL_SECONDS = 120L
        /** The minute in progress is kept on storage this often (seconds). */
        const val SAVE_EVERY_SECONDS = 10L
        private val KIND_MINUTE = JsonPrimitive("minute")
    }
}
