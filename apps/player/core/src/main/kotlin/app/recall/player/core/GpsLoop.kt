// P2.8.2: the GPS service's heart. Once a second by the trusted time, the latest GPS reading is cleaned
// and smoothed (Tracker, P2.6.1: poor fixes and jumps dropped, the area held 15 seconds, the
// moving-hour stopwatch and the 10-minute stop rule), the area goes to the local scheduler (what to
// play, and where each play happened, P2.6/P2.7), and the minute summaries and live positions go to
// the outbox (Minutes, P2.8.1).
//
// Seconds are numbered by the trusted clock, the same clock plays are timed by (review P2.7), never
// by the GPS chip's own stamp. A reading is used only for the second it arrived in (within 1.5 s):
// an old reading is no reading. Seconds the box missed (it was busy) are stepped without a fix, so
// the stopwatch and the minutes stay whole; a jump of the clock by more than 2 minutes (a correction
// from the cloud) starts the tracker afresh rather than invent the seconds between. The clock going
// back waits until it passes the last second done: no second is ever counted twice.
package app.recall.player.core

import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.JsonObject

class GpsLoop(
    /** A report for the cloud (minute summary or live position), made at UTC second `at`. */
    private val send: (JsonObject, Long) -> Unit,
    /** The areas in force (the local scheduler's). */
    private val areas: () -> List<AreaVersion>,
    /** What the tracker settled on, each second (the local scheduler's onSecond). */
    private val onSecond: (Second) -> Unit,
    private val rules: TrackerRules = TrackerRules(),
    private val minutes: Minutes = Minutes(),
    private val log: (String) -> Unit = {},
) {
    private class Reading(val lat: Double, val lng: Double, val accuracyM: Double, val monoMs: Long)

    private var state = TrackerState()
    private var last: Long? = null
    @Volatile private var reading: Reading? = null
    private val plays = AtomicLong()
    private val skipped = AtomicLong()

    /** Seconds the box had to step without looking (it fell behind). Health, P2.11. */
    val missedSeconds: Long get() = skipped.get()

    /** A reading from the GPS chip, taken at the box's counter `monoMs` (any thread). */
    fun onFix(lat: Double, lng: Double, accuracyM: Double?, monoMs: Long) {
        // No accuracy given: treated as a poor fix (the tracker drops it).
        reading = Reading(lat, lng, accuracyM?.takeIf { it.isFinite() && it >= 0 } ?: Double.MAX_VALUE, monoMs)
    }

    /** A play was recorded (any thread): counted in the minute it is recorded in. */
    fun played() {
        plays.incrementAndGet()
    }

    /** The second `t` (UTC, trusted clock) has begun, at the box's counter `monoMs`. */
    @Synchronized
    fun tick(t: Long, monoMs: Long) {
        val before = last
        if (before != null && t <= before) return
        val from = if (before == null || t - before > MAX_FILL_SECONDS) {
            if (before != null) {
                log("gps: the clock jumped ${t - before} s: tracker started afresh")
                minutes.flush().forEach { out(it, before) }
                state = TrackerState()
            }
            t
        } else {
            before + 1
        }
        if (t > from) skipped.addAndGet(t - from)
        for (s in from..t) {
            val r = reading?.takeIf { s == t && monoMs - it.monoMs in 0..FRESH_MS }
            if (r != null) reading = null // one reading, one second
            val fix = r?.let { GpsFix(s, it.lat, it.lng, it.accuracyM) }
            val (next, second) = Tracker.step(state, s, fix, areas(), rules)
            state = next
            runCatching { onSecond(second) }.onFailure { log("gps: area not passed on: ${it.message}") }
            minutes.add(second, playsNow = if (s == t) plays.getAndSet(0) else 0).forEach { out(it, s) }
        }
        last = t
    }

    /** At shutdown: the minute in progress goes out. */
    @Synchronized
    fun flush() {
        val at = last ?: return
        minutes.flush().forEach { out(it, at) }
    }

    private fun out(report: JsonObject, at: Long) {
        runCatching { send(report, at) }.onFailure { log("gps: report not stored: ${it.javaClass.simpleName}: ${it.message}") }
    }

    companion object {
        /** A reading this old (ms) when its second begins is no reading. */
        const val FRESH_MS = 1_500L
        /** Missed seconds up to this are stepped without a fix; a bigger jump starts afresh. */
        const val MAX_FILL_SECONDS = 120L
    }
}
