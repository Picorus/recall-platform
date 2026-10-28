// P2.6.3: the box's local scheduler, one per app process (files/schedule). The line hands it the
// cloud's areas, plans and assignments; playback asks it what to play (Playback.plans). The area comes
// from the GPS tracker (P2.6.1), fed every second by the GPS service (P2.8); until then the box counts
// as outside every area and plays RECALL's own ads.
package app.recall.player

import android.content.Context
import android.os.SystemClock
import android.util.Log
import app.recall.player.core.DownKind
import app.recall.player.core.LocalScheduler
import java.io.File

object Schedule {
    @Volatile var scheduler: LocalScheduler? = null
        private set

    /** Starts with what is kept on storage, so the screen knows its plans before any signal. */
    @Synchronized
    fun start(context: Context, screenId: String) {
        if (scheduler != null) return
        val s = LocalScheduler(
            File(context.applicationContext.filesDir, "schedule"),
            screenId,
            // A message dated well ahead of the trusted time is refused (P2.6.3 review).
            nowMs = { Line.clock.get().now(SystemClock.elapsedRealtime()) },
            log = { Log.i("RecallSchedule", it) },
        )
        scheduler = s
        Playback.plans = s
    }

    /** A message from the cloud for the scheduler; false when it is not one. */
    fun onMessage(kind: DownKind, payload: ByteArray): Boolean {
        val s = scheduler ?: return false
        val text = String(payload)
        when (kind) {
            DownKind.AREAS -> s.onAreas(text)
            DownKind.PLAN -> s.onPlans(text)
            DownKind.ASSIGN -> s.onAssign(text)
            DownKind.POC -> s.onPoc(text)
            else -> return false
        }
        return true
    }
}
