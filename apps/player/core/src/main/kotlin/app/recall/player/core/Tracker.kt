// P2.6 (and P2.8): what the screen works out every second from GPS: a cleaned position, which area it
// is in, whether the bike is moving, and whether the moving-hour clock runs (P1.2.1–P1.2.3). The same
// pure function as the cloud's reference (packages/domain/src/screen-tracker.ts step), checked against
// the same shared cases (test-vectors/screen-tracker.json), so the screen, the simulator and the
// cloud's re-checks give identical answers for the same seconds.
package app.recall.player.core

/** Thresholds. Settings the cloud sends to every screen. */
data class TrackerRules(
    /** P1.2.1: drop fixes the chip itself rates worse than this, metres. */
    val maxAccuracyM: Double = 50.0,
    /** P1.2.1: drop a fix that would mean moving faster than this from the last good one. */
    val maxSpeedKmh: Double = 150.0,
    /** After this many jumps in a row, trust the new position (the old one was the bad one). */
    val jumpResetAfter: Int = 5,
    /** P1.2.1: smoothing: average of the last N good fixes. */
    val smoothOver: Int = 3,
    /** P1.2.2: a new area must hold this many seconds (with GPS) before the screen switches to it. */
    val areaHoldSeconds: Int = 15,
    /** P1.2.3: moving = above this speed… */
    val movingKmh: Double = 5.0,
    /** …on average (start-to-end distance) over this many seconds. */
    val movingWindowSeconds: Long = 30,
    /** In standby, wake when the bike covers `movingKmh` over this shorter window. */
    val wakeWindowSeconds: Long = 10,
    /** P1.2.3, the 10-minute stop rule: standing still longer than this pauses the clock. */
    val standbyAfterSeconds: Long = 600,
)

/** One GPS reading as the chip reports it. `t`: whole seconds since 1970, UTC. */
data class GpsFix(val t: Long, val lat: Double, val lng: Double, val accuracyM: Double)

/**
 * USED: a normal good fix. RESET: a run of jumps long and steady enough to trust (the earlier position
 * was the bad one). The rest are dropped.
 */
enum class FixVerdict(val word: String) { USED("used"), RESET("reset"), NO_FIX("no-fix"), POOR_ACCURACY("poor-accuracy"), JUMP("jump") }

data class TimedPoint(val t: Long, val lat: Double, val lng: Double) {
    val at: LatLng get() = LatLng(lat, lng)
}

data class TrackerState(
    val t: Long? = null,
    /** Last fix accepted as real (not smoothed). */
    val lastGood: TimedPoint? = null,
    /** Fixes dropped as jumps in a row, oldest first, while they agree with each other. */
    val jumps: List<TimedPoint> = emptyList(),
    /** Last `smoothOver` good fixes, oldest first. */
    val recent: List<TimedPoint> = emptyList(),
    /** Smoothed positions over the moving window, oldest first. */
    val track: List<TimedPoint> = emptyList(),
    /** The area the screen is acting on. */
    val place: Place = Place.Outside,
    /** A different area seen, and on how many seconds with GPS, while it waits out the hold. */
    val pending: Pair<Place, Int>? = null,
    val moving: Boolean = false,
    /** First second of the current stop (null while moving). */
    val stillSince: Long? = null,
    /** A screen starts asleep. */
    val standby: Boolean = true,
)

/** What the screen decided for one second. */
data class Second(
    val t: Long,
    val fix: FixVerdict,
    val position: LatLng?,
    val place: Place,
    val moving: Boolean,
    val standby: Boolean,
    /** This second counts towards moving hours (the clock runs unless in standby). */
    val clockRuns: Boolean,
)

object Tracker {
    private fun samePlace(a: Place, b: Place) = a.key == b.key

    private fun kmhBetween(a: TimedPoint, b: TimedPoint) =
        Geo.distanceMeters(a.at, b.at) / maxOf(1L, b.t - a.t) * 3.6

    /**
     * Advance one second. `t` must grow by whole seconds; a null `fix` means no GPS this second.
     * `areas`: the areas that are on, in the versions in force now.
     */
    fun step(s: TrackerState, t: Long, fix: GpsFix?, areas: List<AreaVersion>, rules: TrackerRules = TrackerRules()): Pair<TrackerState, Second> {
        require(s.t == null || t > s.t) { "time went backwards: $t after ${s.t}" }
        val (verdict, jumps) = judge(fix, t, s, rules)

        var lastGood = s.lastGood
        var recent = s.recent
        var track = s.track
        if ((verdict == FixVerdict.USED || verdict == FixVerdict.RESET) && fix != null) {
            val p = TimedPoint(t, fix.lat, fix.lng)
            val reset = verdict == FixVerdict.RESET
            lastGood = p
            // After a reset the old positions were the bad ones: the average and the track start afresh.
            recent = if (reset) listOf(p) else (recent + p).takeLast(rules.smoothOver)
            val smooth = TimedPoint(t, recent.sumOf { it.lat } / recent.size, recent.sumOf { it.lng } / recent.size)
            track = if (reset) listOf(smooth) else track + smooth
        }
        val keepFrom = t - maxOf(rules.movingWindowSeconds, rules.wakeWindowSeconds)
        track = track.filter { it.t >= keepFrom }
        // This second's smoothed position, when this second had a good fix.
        val fresh = track.lastOrNull()?.takeIf { it.t == t }

        // P1.2.2: the area, with a hold so a bike riding along a border does not flicker. The new area
        // must be seen on `areaHoldSeconds` seconds with GPS; seconds without GPS do not count.
        var place = s.place
        var pending = s.pending
        if (fresh != null) {
            val seen = Areas.locate(fresh.at, areas)
            if (samePlace(seen, place)) {
                pending = null
            } else if (s.lastGood == null) {
                place = seen
            } else if (pending != null && samePlace(pending.first, seen)) {
                pending = seen to pending.second + 1
            } else {
                pending = seen to 1
            }
            if (pending != null && pending.second >= rules.areaHoldSeconds) {
                place = pending.first
                pending = null
            }
        }

        // P1.2.3: moving, and the 10-minute stop rule (see the cloud's reference for the reasons).
        val confirmed = (windowKmh(track, t, rules.movingWindowSeconds) ?: 0.0) > rules.movingKmh
        val waking = (windowKmh(track, t, rules.wakeWindowSeconds) ?: 0.0) > rules.movingKmh
        val moving = confirmed || waking
        val stillSince = if (confirmed) null else (s.stillSince ?: t)
        val standby = if (moving || stillSince == null) false else s.standby || t - stillSince + 1 > rules.standbyAfterSeconds
        val state = TrackerState(t, lastGood, jumps, recent, track, place, pending, moving, stillSince, standby)
        return state to Second(t, verdict, fresh?.at, place, moving, standby, clockRuns = !standby)
    }

    /** What to do with this second's fix, and the run of jumps that follows from it. */
    private fun judge(fix: GpsFix?, t: Long, s: TrackerState, rules: TrackerRules): Pair<FixVerdict, List<TimedPoint>> {
        if (fix == null) return FixVerdict.NO_FIX to s.jumps
        require(fix.t == t) { "fix time ${fix.t} is not this second $t" }
        if (!(fix.accuracyM <= rules.maxAccuracyM)) return FixVerdict.POOR_ACCURACY to s.jumps
        val p = TimedPoint(t, fix.lat, fix.lng)
        val last = s.lastGood
        if (last == null || kmhBetween(last, p) <= rules.maxSpeedKmh) return FixVerdict.USED to emptyList()
        // A jump. Keep a run only while its fixes agree with each other; a scattered run starts again.
        val prev = s.jumps.lastOrNull()
        val run = if (prev != null && kmhBetween(prev, p) <= rules.maxSpeedKmh) s.jumps + p else listOf(p)
        return if (run.size >= rules.jumpResetAfter) FixVerdict.RESET to emptyList() else FixVerdict.JUMP to run
    }

    /** Start-to-end speed over the last `windowSeconds`, or null without enough track. */
    private fun windowKmh(track: List<TimedPoint>, now: Long, windowSeconds: Long): Double? {
        val from = now - windowSeconds
        val first = track.firstOrNull { it.t >= from } ?: return null
        val last = track.lastOrNull() ?: return null
        // As the cloud: "at least half the window" in real division.
        if ((last.t - first.t).toDouble() < windowSeconds / 2.0) return null
        return Geo.distanceMeters(first.at, last.at) / (last.t - first.t) * 3.6
    }
}
