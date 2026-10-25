// P2.5: keeps the screen playing, spot after spot, without gaps. One thread: a couple of seconds before
// a spot ends it works out the next one (Playout) and has the screen load it behind the one showing
// (Renderer.prepare); when the spot ends it swaps (Renderer.show). The ends come from the trusted
// time, read again for every spot, so a clock correction from the cloud is followed at the next spot.
//
// Each spot shown is handed on (Played) for the signed play log (P2.7). It `counts` only when all of
// this holds: shown by trusted time, from its first second to its last, the screen confirmed it
// started (`started`) and reported no problem, the screen was not covered at any moment of it (blank or
// test pattern, P2.12), an ad was shown (not the slate), and no spot at or after
// that time was counted before (a clock moved back never yields the same spot twice, review P2.5.1).
package app.recall.player.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** The screen: two layers, one showing, the next loading behind it. Calls come from one thread. */
interface Renderer {
    /** Load this spot behind the one showing, so it can be shown at once. */
    fun prepare(spot: Spot)

    /** Show the prepared spot now, from its start. Reports `started` once it is really on screen. */
    fun show(spot: Spot)
}

/** What the screen says about each spot (from any thread); the conductor listens. */
interface ScreenReports {
    /** This spot is on screen (its first frame or picture is showing). */
    fun started(spot: Spot)

    /**
     * The screen could not load or show `spot`. With `fileFault`, the ad's file itself is bad (it is
     * dropped and downloaded again); otherwise it was the screen.
     */
    fun failed(spot: Spot, problem: String, fileFault: Boolean)
}

/** One spot as it was shown: for the signed play log (P2.7) and health (P2.11). */
data class Played(
    val spot: Spot,
    /** Shown from its first second to its last. */
    val whole: Boolean,
    /** The screen confirmed it started and reported no problem. */
    val ok: Boolean,
    val problem: String?,
    /** A play the log may record: see the top of this file. Credit goes to `spot.shows`, never `planned`. */
    val counts: Boolean,
)

/** Waits until the box's counter reaches `monoMs`; false when playback is stopping. */
fun interface Waiter {
    fun until(monoMs: Long): Boolean
}

data class ConductorRules(
    /** The next spot is loaded this long before it starts. */
    val leadMs: Long = 2_000,
    /** Shown this close to its start (and run to this close to its end), a spot is whole. */
    val wholeWithinMs: Long = 500,
    /** Waiting longer than this for a spot's second (the clock moved back), RECALL filler shows meanwhile. */
    val fillerAfterMs: Long = 1_000,
) {
    init {
        require(leadMs > 0 && wholeWithinMs >= 0 && fillerAfterMs > 0)
    }
}

/**
 * The latest spot start ever counted (UTC ms). Shared by every conductor of a playback thread, so a
 * restart never counts a spot twice; P2.7 keeps it on storage across reboots.
 */
class PlayedMark(initial: Long = Long.MIN_VALUE) {
    private val last = AtomicLong(initial)
    val value: Long get() = last.get()

    /** True (and moves on) when `startUtc` is after every spot counted before. */
    fun claim(startUtc: Long): Boolean {
        while (true) {
            val v = last.get()
            if (startUtc <= v) return false
            if (last.compareAndSet(v, startUtc)) return true
        }
    }

    /**
     * A mark well ahead of the cloud's own time (`cloudNowMs`) came from a wrong clock (a faked GPS
     * date): it would stop every real play from counting, even across reboots. Brought back to the
     * cloud's time; true when it was. The cloud still refuses two plays closer than one spot (review P2.7).
     */
    fun pullBack(cloudNowMs: Long, aheadMs: Long = 60_000): Boolean {
        while (true) {
            val v = last.get()
            if (v <= cloudNowMs + aheadMs) return false
            if (last.compareAndSet(v, cloudNowMs)) return true
        }
    }
}

class Conductor(
    private val playout: Playout,
    private val renderer: Renderer,
    /** Trusted time (UTC ms) at a counter value, or null while there is none (TrustedClock.now). */
    private val utcAt: (Long) -> Long?,
    private val mono: () -> Long,
    private val waiter: Waiter,
    private val played: (Played) -> Unit = {},
    /** The screen could not play this ad's file: the store downloads it again (AdStore.damaged). */
    private val badFile: (String) -> Unit = {},
    private val log: (String) -> Unit = {},
    private val rules: ConductorRules = ConductorRules(),
    private val mark: PlayedMark = PlayedMark(),
    /**
     * Why the screen was covered (blanked, test pattern: P2.12) at any moment from counter `sinceMono`
     * until now, or null. A spot covered for any part of it never counts, even one already showing
     * when the cover came (review P2.12).
     */
    private val covered: (sinceMono: Long) -> String? = { null },
) : ScreenReports {
    /** What the screen said about one spot (from any thread). */
    private class Report {
        @Volatile var started = false
        @Volatile var problem: String? = null
    }

    private class Showing(val spot: Spot, val report: Report, val startMono: Long, val endMono: Long, val fromStart: Boolean)

    /** Reports for the spot loading and the spot showing; matched by identity, never by value. */
    @Volatile private var loading: Pair<Spot, Report>? = null
    @Volatile private var showing: Pair<Spot, Report>? = null
    private var untimedTurn = 0
    private val missing = AtomicLong()

    /** Spots shown without their planned ad (not on the box: a RECALL ad or the slate). Health, P2.11. */
    val missingAds: Long get() = missing.get()

    private fun reportFor(spot: Spot): Report? =
        showing?.takeIf { it.first === spot }?.second ?: loading?.takeIf { it.first === spot }?.second

    override fun started(spot: Spot) {
        reportFor(spot)?.started = true
    }

    override fun failed(spot: Spot, problem: String, fileFault: Boolean) {
        reportFor(spot)?.let { if (it.problem == null) it.problem = problem }
        log("play: ${spot.shows?.ad ?: "slate"}: $problem")
        if (fileFault) spot.shows?.ad?.let(badFile)
    }

    private fun load(spot: Spot) {
        loading = spot to Report()
        renderer.prepare(spot)
    }

    /** Plays until the waiter says stop (on the box: its own thread, see PlaybackThread). */
    fun run() {
        var next = now()
        load(next)
        while (true) {
            val m = mono()
            val utc = utcAt(m)
            var start = startMono(next, m, utc)
            val end = endMono(next, m, utc)
            if (next.timed && (start == null || end == null || start > m + playout.spotMs || end <= m)) {
                // The clock moved by a whole spot or more (a correction from the cloud), the time was
                // lost, or the box fell behind: join the spot of now, part-way.
                next = now()
                load(next)
                start = startMono(next, m, utc)
            } else if (start != null && start > m) {
                // A little early (the clock moved back a bit): the spot starts on its own second.
                // Waiting long, RECALL filler shows meanwhile (never counted).
                if (start - m > rules.fillerAfterMs) {
                    val filler = playout.untimed(untimedTurn++)
                    load(filler)
                    val f = show(filler, start, fromStart = false)
                    load(next)
                    val reached = waiter.until(start)
                    finish(f, reached)
                    if (!reached) return
                } else if (!waiter.until(start)) {
                    return
                }
                // Read the time again: it may have moved during the wait.
                continue
            }
            val s = show(next, endMono(next, m, utc) ?: (m + playout.spotMs), fromStart = start != null && m - start <= rules.wholeWithinMs)
            if (!waiter.until(s.endMono - rules.leadMs)) return finish(s, false)
            val after = following(next)
            load(after)
            val reached = waiter.until(s.endMono)
            finish(s, reached)
            if (!reached) return
            next = after
        }
    }

    private fun show(spot: Spot, endMono: Long, fromStart: Boolean): Showing {
        // The report follows the spot from loading to showing, so a problem found while it was
        // loading still counts against it; set before showing, so one reported at once does too.
        val report = loading?.takeIf { it.first === spot }?.second ?: Report()
        val startMono = mono()
        showing = spot to report
        val planned = spot.planned
        if (planned != null && planned.ad.isNotEmpty() && spot.shows != planned) missing.incrementAndGet()
        renderer.show(spot)
        return Showing(spot, report, startMono, endMono, fromStart)
    }

    /** `ran`: the spot ran to its end (false: playback stopped part-way). */
    private fun finish(s: Showing, ran: Boolean) {
        val whole = s.fromStart && ran && mono() >= s.endMono - rules.wholeWithinMs
        val problem = s.report.problem
            ?: runCatching { covered(s.startMono) }.getOrElse { "cover unknown" }
            ?: if (!s.report.started) "the screen did not confirm it started" else null
        val ok = problem == null
        val start = s.spot.startUtc
        val counts = whole && ok && start != null && s.spot.shows != null && mark.claim(start)
        runCatching { played(Played(s.spot, whole, ok, problem, counts)) }
            .onFailure { log("play: not handed on: ${it.message}") }
    }

    /** The spot of this moment: timed when there is a trusted time. */
    private fun now(): Spot = utcAt(mono())?.let(playout::spotAt) ?: playout.untimed(untimedTurn++)

    /** The spot after `s`: the next by time while there is a trusted time, else the spot of now. */
    private fun following(s: Spot): Spot {
        val end = s.endUtc ?: return now()
        if (utcAt(mono()) == null) return now()
        return playout.spotAt(end)
    }

    /** Where `s` starts and ends on the counter, by the trusted time `utc` read at counter `m`. */
    private fun startMono(s: Spot, m: Long, utc: Long?): Long? = s.startUtc?.let { a -> utc?.let { m + (a - it) } }

    private fun endMono(s: Spot, m: Long, utc: Long?): Long? = s.endUtc?.let { a -> utc?.let { m + (a - it) } }
}

/** Waits on the box's real counter; `stop()` ends every wait at once. */
class StoppableWaiter(private val mono: () -> Long) : Waiter {
    private val stopping = CountDownLatch(1)
    val stopped: Boolean get() = stopping.count == 0L

    override fun until(monoMs: Long): Boolean {
        while (true) {
            val left = monoMs - mono()
            if (left <= 0) return !stopped
            if (stopping.await(left, TimeUnit.MILLISECONDS)) return false
        }
    }

    fun stop() = stopping.countDown()
}

/**
 * Plays on its own thread. Anything that goes wrong (even an Error) starts playback again a second
 * later with a fresh conductor: the screen must never stay dark. `make` gets the waiter and the
 * shared mark, so a fresh conductor never counts a spot an earlier one counted.
 */
class PlaybackThread(
    private val mono: () -> Long,
    private val make: (Waiter, PlayedMark) -> Conductor,
    private val log: (String) -> Unit = {},
    private val mark: PlayedMark = PlayedMark(),
) {
    private val waiter = StoppableWaiter(mono)
    private var thread: Thread? = null

    @Synchronized
    fun start() {
        if (thread != null) return
        thread = Thread({
            while (!waiter.stopped) {
                try {
                    make(waiter, mark).run()
                } catch (e: Throwable) {
                    try {
                        log("play: ${e.javaClass.simpleName}: ${e.message}; starting again")
                        waiter.until(mono() + 1_000)
                    } catch (_: Throwable) {
                        // Even the pause failed: start again at once rather than end the thread.
                    }
                }
            }
        }, "recall-play").apply {
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun stop(waitMs: Long = 5_000) {
        waiter.stop()
        thread?.join(waitMs)
    }
}
