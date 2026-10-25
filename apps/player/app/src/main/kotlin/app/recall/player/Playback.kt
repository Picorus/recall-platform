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
        val s = Screen(activity, root)
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
                    if (!p.counts && p.spot.timed) log("not counted: ${p.spot.shows?.ad ?: "slate"} at ${p.spot.startUtc}: ${p.problem ?: if (!p.whole) "not whole" else "no ad or no time"}")
                    val plays = playLog
                    if (p.counts && plays == null) log("counted but not recorded (no play log yet): ${p.spot.shows?.ad} at ${p.spot.startUtc}")
                    plays?.record(p)
                },
                badFile = { ad -> checks.execute { runCatching { Ads.store?.damaged(ad) } } },
                log = log,
                mark = mark,
            ).also {
                s.reports = it
                conductor = it
            }
        }, log, counted).also { it.start() }
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
