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

    private fun countFile(context: Context) = File(context.filesDir, "crash-count")

    /**
     * Crashes of the player since the box was set up (kept across restarts): updates are judged by
     * them (P2.13). Counted from Android's own record of why the player's process ended, so crashes
     * in native code (the video decoder), freezes (not responding) and crashes before the player
     * could note anything all count (review P2.13); the watchdog's process is not counted.
     */
    @Synchronized
    fun count(context: Context): Long {
        val f = countFile(context)
        val (total, seen) = runCatching {
            f.readText().trim().split(" ").let { it[0].toLong() to it[1].toLong() }
        }.getOrDefault(0L to 0L)
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        val exits = runCatching { am.getHistoricalProcessExitReasons(context.packageName, 0, 0) }.getOrDefault(emptyList())
        val fresh = exits.filter {
            it.timestamp > seen && it.processName == context.packageName &&
                it.reason in setOf(
                    android.app.ApplicationExitInfo.REASON_CRASH,
                    android.app.ApplicationExitInfo.REASON_CRASH_NATIVE,
                    android.app.ApplicationExitInfo.REASON_ANR,
                )
        }
        if (fresh.isEmpty()) return total
        val now = total + fresh.size
        // Written whole or not at all: a count is never lost to a power cut mid-write.
        val tmp = File(f.parentFile, "crash-count.tmp")
        java.io.FileOutputStream(tmp).use {
            it.write("$now ${fresh.maxOf { e -> e.timestamp }}".toByteArray())
            it.fd.sync()
        }
        tmp.renameTo(f)
        return now
    }

    /** Adds a line (kept to the last 50). */
    fun record(context: Context, what: String) {
        val f = file(context)
        val lines = (if (f.exists()) f.readLines() else emptyList()) + "${System.currentTimeMillis() / 1000} $what"
        f.writeText(lines.takeLast(KEEP).joinToString("\n", postfix = "\n"))
    }
}
