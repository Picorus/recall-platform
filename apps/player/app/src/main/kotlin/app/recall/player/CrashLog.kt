// P2.2: every crash is written down (time, what failed) before the process dies, so the health
// report (P2.11) can send it; the watchdog then brings the player back.
package app.recall.player

import android.content.Context
import android.os.Process
import java.io.File
import kotlin.system.exitProcess

object CrashLog {
    private const val KEEP = 50

    fun file(context: Context) = File(context.filesDir, "crashes.log")

    /**
     * After writing the crash down, the process ends itself at once. Android's own crash handler
     * would ask the system to show a "has stopped" box and wait for an answer nobody gives on a
     * kiosk; meanwhile the half-dead process stays alive, and the watchdog's restart lands in it
     * and freezes until Android gives up (seen on the emulator: well over 5 seconds).
     */
    fun install(context: Context) {
        val app = context.applicationContext
        Thread.setDefaultUncaughtExceptionHandler { _, error ->
            runCatching { record(app, "crash ${error.javaClass.name}: ${error.message?.take(200) ?: ""}") }
            Process.killProcess(Process.myPid())
            exitProcess(10)
        }
    }

    /** Adds a line (kept to the last 50). */
    fun record(context: Context, what: String) {
        val f = file(context)
        val lines = (if (f.exists()) f.readLines() else emptyList()) + "${System.currentTimeMillis() / 1000} $what"
        f.writeText(lines.takeLast(KEEP).joinToString("\n", postfix = "\n"))
    }
}
