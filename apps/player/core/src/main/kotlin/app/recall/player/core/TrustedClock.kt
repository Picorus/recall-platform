// P2.3: the box's idea of the time. Plays are stamped with it, so it must be right (plan: "clock set
// from network and GPS time"). The box's own clock is not trusted: it can be wrong after a power cut
// or changed by hand. Two sources set it:
//   GPS time, from each fix: good to well under a second.
//   The cloud's time, in reply to each hello over the secure line: good to half the round trip.
// Between samples the time runs on the box's monotonic counter (which nobody can set). The source
// with the smaller doubt wins; if the two disagree by more than 10 seconds the cloud wins (GPS can be
// faked with a cheap transmitter, the cloud's time comes over our own secure line) and it is flagged.
// Until a source has been heard the time is unknown (null), and nothing that needs it is stamped.
package app.recall.player.core

data class ClockRules(
    /** Doubt in a GPS time. */
    val gpsDoubtMs: Long = 500,
    /** A cloud reply slower than this is not used: the doubt would be too large. */
    val longestRoundTripMs: Long = 10_000,
    /** How fast a counter can drift: 200 parts per million, 0.72 seconds an hour. */
    val driftPpm: Long = 200,
    /** The two sources may differ by this much before the cloud is preferred and it is flagged. */
    val disagreeMs: Long = 10_000,
) {
    init {
        require(gpsDoubtMs > 0 && longestRoundTripMs > 0 && driftPpm >= 0 && disagreeMs > 0)
    }
}

enum class TimeSource { GPS, CLOUD }

/** One reading: at monotonic `monoMs` the time was `utcMs`, give or take `doubtMs`. */
data class TimeSample(val source: TimeSource, val utcMs: Long, val monoMs: Long, val doubtMs: Long)

/** The latest reading from each source. Immutable, so testable. */
data class TrustedClock(val gps: TimeSample? = null, val cloud: TimeSample? = null) {
    /** A GPS fix's time, taken at monotonic `monoMs`. */
    fun withGps(utcMs: Long, monoMs: Long, rules: ClockRules = ClockRules()) =
        if (!believable(utcMs)) this else copy(gps = TimeSample(TimeSource.GPS, utcMs, monoMs, rules.gpsDoubtMs))

    /**
     * The cloud's time `utcMs`, in reply to a hello sent at monotonic `sentMono` and received at
     * `receivedMono`. The cloud read its clock somewhere in the round trip: the middle is the best guess.
     */
    fun withCloud(utcMs: Long, sentMono: Long, receivedMono: Long, rules: ClockRules = ClockRules()): TrustedClock {
        val trip = receivedMono - sentMono
        if (trip < 0 || trip > rules.longestRoundTripMs || !believable(utcMs)) return this
        return copy(cloud = TimeSample(TimeSource.CLOUD, utcMs, sentMono + trip / 2, trip / 2 + 1))
    }

    private fun at(s: TimeSample, monoMs: Long) = s.utcMs + (monoMs - s.monoMs)
    private fun doubt(s: TimeSample, monoMs: Long, r: ClockRules) =
        s.doubtMs + (monoMs - s.monoMs) * r.driftPpm / 1_000_000

    /** True when both sources are known and differ by more than they should (for the health report). */
    fun disagree(monoMs: Long, rules: ClockRules = ClockRules()): Boolean {
        val g = gps?.takeIf { it.monoMs <= monoMs } ?: return false
        val c = cloud?.takeIf { it.monoMs <= monoMs } ?: return false
        return Math.abs(at(g, monoMs) - at(c, monoMs)) > rules.disagreeMs + doubt(g, monoMs, rules) + doubt(c, monoMs, rules)
    }

    private fun best(monoMs: Long, rules: ClockRules): TimeSample? {
        // A reading from "the future" of the counter (it restarts from 0 when the box restarts) is
        // never used: the time must come from this run of the counter.
        val g = gps?.takeIf { it.monoMs <= monoMs }
        val c = cloud?.takeIf { it.monoMs <= monoMs }
        return when {
            g == null -> c
            c == null -> g
            disagree(monoMs, rules) -> c
            doubt(g, monoMs, rules) <= doubt(c, monoMs, rules) -> g
            else -> c
        }
    }

    /** The time now (UTC ms) at monotonic `monoMs`, or null while no source has been heard. */
    fun now(monoMs: Long, rules: ClockRules = ClockRules()): Long? = best(monoMs, rules)?.let { at(it, monoMs) }

    /** The time by the cloud's reading only (UTC ms), or null: for decisions GPS must not drive. */
    fun cloudNow(monoMs: Long): Long? = cloud?.takeIf { it.monoMs <= monoMs }?.let { at(it, monoMs) }

    /** How far off `now` may be, in ms, or null while unknown. */
    fun doubtMs(monoMs: Long, rules: ClockRules = ClockRules()): Long? = best(monoMs, rules)?.let { doubt(it, monoMs, rules) }

    private companion object {
        /** 2026-01-01 to 2100-01-01, as the cloud checks: a GPS week roll-over gives 2006 dates. */
        fun believable(utcMs: Long) = utcMs in 1_767_225_600_000L until 4_102_444_800_000L
    }
}
