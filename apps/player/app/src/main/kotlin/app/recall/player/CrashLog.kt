// P2.2: every crash is written down (time, what failed) before the process dies, so the health
// report (P2.11) can send it; the watchdog then brings the player back.
package app.recall.player

import android.content.Context
import java.io.File

object CrashLog {
    private const val KEEP = 50

    fun file(context: Context) = File(context.filesDir, "crashes.log")

    fun install(context: Context) {
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            runCatching { record(app, "crash ${error.javaClass.name}: ${error.message?.take(200) ?: ""}") }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Adds a line (kept to the last 50). */
    fun record(context: Context, what: String) {
        val f = file(context)
        val lines = (if (f.exists()) f.readLines() else emptyList()) + "${System.currentTimeMillis() / 1000} $what"
        f.writeText(lines.takeLast(KEEP).joinToString("\n", postfix = "\n"))
    }
}
