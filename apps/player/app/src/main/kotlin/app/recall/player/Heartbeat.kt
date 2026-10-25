// P2.2: the player's heartbeat, shared with the watchdog process through a small file (same app,
// two processes). Times are the boot clock (elapsedRealtime), the same in both processes.
package app.recall.player

import android.content.Context
import android.os.SystemClock
import java.io.File

object Heartbeat {
    private fun file(context: Context) = File(context.filesDir, "heartbeat")

    fun beat(context: Context) {
        val f = file(context)
        val tmp = File(f.parentFile, "heartbeat.tmp")
        tmp.writeText(SystemClock.elapsedRealtime().toString())
        tmp.renameTo(f) // atomic: the watchdog never reads half a number
    }

    /** The last beat (boot clock, ms), or null when there is none since this boot. */
    fun last(context: Context): Long? {
        val t = runCatching { file(context).readText().trim().toLong() }.getOrNull() ?: return null
        // A beat from before a reboot reads as larger than the clock now: not a beat of this boot.
        return t.takeIf { it <= SystemClock.elapsedRealtime() }
    }
}
