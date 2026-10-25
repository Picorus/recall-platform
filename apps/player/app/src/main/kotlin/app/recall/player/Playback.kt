// P2.5: playback on the box, started with the player's screen. Spots follow the trusted clock
// (Line.clock), ads come from the ad store (Ads, P2.4), and what to play comes from the hour plan and
// what the bike carries (`plans`, filled by the local scheduler, P2.6; until then RECALL's ads or the
// slate). Each spot shown is handed on for the signed play log (P2.7; logged for now).
package app.recall.player

import android.app.Activity
import android.os.SystemClock
import android.util.Log
import android.widget.FrameLayout
import app.recall.player.core.Conductor
import app.recall.player.core.PlanSource
import app.recall.player.core.PlaybackThread
import app.recall.player.core.PlayedMark
import app.recall.player.core.Playout
import java.util.concurrent.Executors

object Playback {
    /** The plan and what the bike carries at a time (P2.6). */
    @Volatile var plans: PlanSource = PlanSource { null }

    /** The latest spot counted (P2.7 keeps it on storage across reboots). */
    val mark = PlayedMark()

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
        thread = PlaybackThread(SystemClock::elapsedRealtime, { waiter, mark ->
            val playout = Playout({ t -> plans.at(t) }, { ad -> Ads.store?.file(ad) }, log = log)
            Conductor(
                playout = playout,
                renderer = s,
                utcAt = { m -> Line.clock.get().now(m) },
                mono = SystemClock::elapsedRealtime,
                waiter = waiter,
                played = { p -> log("played ${p.spot.shows?.ad ?: "slate"} at ${p.spot.startUtc} whole=${p.whole} ok=${p.ok} counts=${p.counts}") },
                badFile = { ad -> checks.execute { runCatching { Ads.store?.damaged(ad) } } },
                log = log,
                mark = mark,
            ).also {
                s.reports = it
                conductor = it
            }
        }, log, mark).also { it.start() }
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
