// P2.5: playback on the box, started with the player's screen. Spots follow the trusted clock
// (Line.clock), ads come from the ad store (Ads, P2.4), and what to play comes from the hour plan and
// what the bike carries (`plans`, filled by the local scheduler, P2.6; until then RECALL's ads or the
// slate). Each spot shown is handed on to the signed play log (P2.7, started by the line), which
// records the ones that count.
package app.recall.player

import android.app.Activity
import android.content.Context
import android.os.SystemClock
import android.util.Log
import android.widget.FrameLayout
import app.recall.player.core.Conductor
import app.recall.player.core.MarkFile
import app.recall.player.core.PlanSource
import app.recall.player.core.PlayLog
import app.recall.player.core.Played
import app.recall.player.core.PlaybackThread
import app.recall.player.core.PlayedMark
import app.recall.player.core.Playout
import java.io.File
import java.util.concurrent.Executors

object Playback {
    /** The plan and what the bike carries at a time (P2.6). */
    @Volatile var plans: PlanSource = PlanSource { null }

    /** Where counted plays are signed and stored (P2.7); null until the line has started it. */
    @Volatile var playLog: PlayLog? = null
        private set
    /** Plays counted before the play log was there (just after a boot): handed on when it is. */
    private val early = ArrayDeque<Played>()

    /** The play log is ready: plays counted before it go to it first, in order. */
    fun attach(log: PlayLog) {
        synchronized(early) {
            early.forEach(log::record)
            early.clear()
            playLog = log
        }
    }

    private fun record(p: Played, log: (String) -> Unit) {
        playLog?.let { return it.record(p) }
        synchronized(early) {
            val plays = playLog
            when {
                plays != null -> plays.record(p)
                early.size < EARLY_MAX -> early.addLast(p)
                else -> log("counted but not recorded (no play log): ${p.spot.shows?.ad} at ${p.spot.startUtc}")
            }
        }
    }

    private val notCounted = java.util.concurrent.atomic.AtomicLong()
    private val missing = java.util.concurrent.atomic.AtomicLong()
    /** Spots shown by trusted time that did not count (late, cut short, not confirmed). Health, P2.11. */
    val spotsNotCounted: Long get() = notCounted.get()
    /** Spots shown without their planned ad (not on the box). Health, P2.11. */
    val adsMissing: Long get() = missing.get()

    /** About an hour of spots. */
    private const val EARLY_MAX = 240

    /** The latest spot counted, read from storage once (P2.7): never counted twice across reboots. */
    private var mark: PlayedMark? = null

    fun markFile(context: Context) = MarkFile(File(context.applicationContext.filesDir, "plays/mark"))

    /** Checks of files the screen could not play (a fingerprint takes a moment: never on the main thread). */
    private val checks = Executors.newSingleThreadExecutor { Thread(it, "recall-check").apply { isDaemon = true } }

    private var owner: Activity? = null
    private var screen: Screen? = null
    private var thread: PlaybackThread? = null
    @Volatile var conductor: Conductor? = null
        private set

    /** Starts playing on `root` (main thread). */
    @Synchronized
    fun start(activity: Activity, root: FrameLayout) {
        owner?.let(::stop)
        owner = activity
        // A screen left blanked by a command stays dark after a restart (P2.12).
        Remote.load(activity)
        val s = Screen(activity, root, cover = Remote::coverReason, testPattern = Remote::testPatternOn)
        screen = s
        val log: (String) -> Unit = { m -> Log.i("RecallPlay", m) }
        val counted = mark ?: PlayedMark(markFile(activity).load()).also { mark = it }
        thread = PlaybackThread(SystemClock::elapsedRealtime, { waiter, mark ->
            val playout = Playout({ t -> plans.at(t) }, { ad -> Ads.store?.file(ad) }, log = log)
            Conductor(
                playout = playout,
                renderer = s,
                utcAt = { m -> Line.clock.get().now(m) },
                mono = SystemClock::elapsedRealtime,
                waiter = waiter,
                played = { p ->
                    // Spots under a blank or test pattern are meant not to count: not a fault (review P2.12).
                    val covered = Remote.isCover(p.problem)
                    if (!p.counts && p.spot.timed && !covered) notCounted.incrementAndGet()
                    val planned = p.spot.planned
                    if (planned != null && planned.ad.isNotEmpty() && p.spot.shows != planned) missing.incrementAndGet()
                    if (!p.counts && p.spot.timed && !covered) log("not counted: ${p.spot.shows?.ad ?: "slate"} at ${p.spot.startUtc}: ${p.problem ?: if (!p.whole) "not whole" else "no ad or no time"}")
                    if (p.counts) record(p, log)
                    // A mark left by a wrong clock (a faked GPS date) must not stop counting for good.
                    Line.clock.get().cloudNow(SystemClock.elapsedRealtime())?.let { now ->
                        if (mark.pullBack(now)) log("play mark was ahead of the cloud's time: brought back")
                    }
                },
                badFile = { ad -> checks.execute { runCatching { Ads.store?.damaged(ad) } } },
                log = log,
                mark = mark,
                covered = Remote::coveredSince,
            ).also {
                s.reports = it
                conductor = it
            }
        }, log, counted).also { it.start() }
    }

    /** The blank or test-pattern cover changed (P2.12): the screen shows it now (main thread). */
    fun refreshCover() {
        screen?.refreshCover()
    }

    /** Stops playback started by `activity` (an older screen going away never stops a newer one). */
    @Synchronized
    fun stop(activity: Activity) {
        if (activity !== owner) return
        owner = null
        // Never hold up the main thread: the playback thread ends at its next wait; the screen
        // ignores anything it still sends after its release.
        thread?.stop(waitMs = 200)
        thread = null
        screen?.release()
        screen = null
        conductor = null
    }
}
