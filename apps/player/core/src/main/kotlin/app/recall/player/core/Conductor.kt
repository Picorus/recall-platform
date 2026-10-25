// P2.5: keeps the screen playing, spot after spot, without gaps. One thread: a couple of seconds before
// a spot ends it works out the next one (Playout) and has the screen load it behind the one showing
// (Renderer.prepare); when the spot ends it swaps (Renderer.show). The ends come from the trusted
// time, read again for every spot, so a clock correction from the cloud is followed at the next spot.
// Each spot shown is handed on (Played) for the signed play log (P2.7); a spot joined part-way (at
// start, or after a clock jump) is marked so and never counts as a play.
package app.recall.player.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** The screen: two layers, one showing, the next loading behind it. Calls come from one thread. */
interface Renderer {
    /** Load this spot behind the one showing, so it can be shown at once. */
    fun prepare(spot: Spot)

    /** Show the prepared spot now, from its start. */
    fun show(spot: Spot)
}

/** One spot as it was shown: for the signed play log (P2.7) and health (P2.11). */
data class Played(
    val spot: Spot,
    /** Shown from its very start (not joined part-way). */
    val whole: Boolean,
    /** Shown without a problem reported by the screen. */
    val ok: Boolean,
    val problem: String?,
)

/** Waits until the box's counter reaches `monoMs`; false when playback is stopping. */
fun interface Waiter {
    fun until(monoMs: Long): Boolean
}

data class ConductorRules(
    /** The next spot is loaded this long before it starts. */
    val leadMs: Long = 2_000,
    /** Shown this close to its start, a spot counts as whole. */
    val wholeWithinMs: Long = 500,
) {
    init {
        require(leadMs > 0 && wholeWithinMs >= 0)
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
) {
    private class Showing(val spot: Spot, val shownMono: Long, val endMono: Long, val whole: Boolean) {
        @Volatile var problem: String? = null
    }

    @Volatile private var showing: Showing? = null
    private var untimedTurn = 0
    private val missing = AtomicLong()

    /** Spots shown without their planned ad (not on the box: a RECALL ad or the slate). Health, P2.11. */
    val missingAds: Long get() = missing.get()

    /**
     * The screen could not show `spot` (any thread). With `fileFault`, the ad's file itself is bad
     * (it is dropped and downloaded again); otherwise it was the screen.
     */
    fun failed(spot: Spot, problem: String, fileFault: Boolean) {
        val s = showing
        if (s != null && s.spot === spot) s.problem = problem
        log("play: ${spot.shows?.ad ?: "slate"}: $problem")
        if (fileFault) spot.shows?.ad?.let(badFile)
    }

    /** Plays until the waiter says stop (on the box: its own thread, see `start`). */
    fun run() {
        var next = now()
        renderer.prepare(next)
        while (true) {
            var m = mono()
            var start = startMono(next, m)
            if (start != null && (start > m + playout.spotMs || endMono(next, m)!! <= m)) {
                // The clock moved by a whole spot or more (a correction from the cloud), or the box
                // fell behind: join the spot of now, part-way.
                next = now()
                renderer.prepare(next)
                start = startMono(next, m)
            } else if (start != null && start > m) {
                // A little early (the clock moved back a bit): the spot starts on its second.
                if (!waiter.until(start)) return
                m = mono()
            }
            val s = Showing(
                next,
                m,
                endMono(next, m) ?: (m + playout.spotMs),
                whole = start != null && m - start <= rules.wholeWithinMs,
            )
            // Before showing: a problem the screen reports at once belongs to this spot.
            showing = s
            val planned = next.planned
            if (planned != null && planned.ad.isNotEmpty() && next.shows != planned) missing.incrementAndGet()
            renderer.show(next)
            if (!waiter.until(s.endMono - rules.leadMs)) return finish(s)
            val after = following(next)
            renderer.prepare(after)
            if (!waiter.until(s.endMono)) return finish(s)
            finish(s)
            next = after
        }
    }

    private fun finish(s: Showing) {
        val problem = s.problem
        runCatching { played(Played(s.spot, s.whole, problem == null, problem)) }
            .onFailure { log("play: not handed on: ${it.message}") }
    }

    /** The spot of this moment: timed when there is a trusted time. */
    private fun now(): Spot = utcAt(mono())?.let(playout::spotAt) ?: playout.untimed(untimedTurn++)

    /** The spot after `s`: the next by time, or (no time yet) the next RECALL turn, or timed once time comes. */
    private fun following(s: Spot): Spot {
        val end = s.endUtc ?: return now()
        return playout.spotAt(end)
    }

    /** Where `s` starts on the counter, by the trusted time now; null for an untimed spot. */
    private fun startMono(s: Spot, m: Long): Long? {
        val start = s.startUtc ?: return null
        val utc = utcAt(m) ?: return null
        return m + (start - utc)
    }

    private fun endMono(s: Spot, m: Long): Long? {
        val end = s.endUtc ?: return null
        val utc = utcAt(m) ?: return null
        return m + (end - utc)
    }
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
 * later with a fresh conductor: the screen must never stay dark.
 */
class PlaybackThread(
    private val mono: () -> Long,
    private val make: (Waiter) -> Conductor,
    private val log: (String) -> Unit = {},
) {
    private val waiter = StoppableWaiter(mono)
    private var thread: Thread? = null

    @Synchronized
    fun start() {
        if (thread != null) return
        thread = Thread({
            while (!waiter.stopped) {
                try {
                    make(waiter).run()
                } catch (e: Throwable) {
                    log("play: ${e.javaClass.simpleName}: ${e.message}; starting again")
                    waiter.until(mono() + 1_000)
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
