// P2.12: remote commands on the box. The line hands each command to the runner (core, CommandRunner:
// once only, never expired, answered through the outbox); this is what each one does here.
//  - blank: the screen goes dark over the ads, and stays dark across restarts until "unblank" (a
//    cracked panel, an accident). Nothing shown under it counts: no brand pays for a dark screen.
//  - test pattern: colour bars for the seconds asked; nothing under it counts either.
//  - brightness: a fixed brightness, or automatic again (P2.10), always within the safe day and night
//    limits and changed smoothly; forgotten on restart.
//  - reboot: the box restarts (as device owner), a few seconds after its answer is stored.
//  - send logs: the end of the box's own log goes back in the answer.
//  - clear cache: the app's cache (never the ads, plans, plays or outbox).
package app.recall.player

import android.app.admin.DevicePolicyManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import app.recall.player.core.CommandActions
import app.recall.player.core.CommandRunner
import app.recall.player.core.Outbox
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

object Remote {
    @Volatile private var runner: CommandRunner? = null
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private var loaded = false

    @Volatile var blanked = false
        private set
    /** When the last blank ended (box counter), so a spot it touched never counts. */
    @Volatile private var blankEnded = Long.MIN_VALUE
    @Volatile private var testFrom = Long.MIN_VALUE
    @Volatile private var testUntil = Long.MIN_VALUE
    /** A brightness set by a command (percent), or null for automatic. */
    @Volatile var brightness: Int? = null
        private set

    const val BLANKED = "blanked by a command"
    const val TEST = "test pattern"

    /** Why ads do not count right now (blanked, test pattern), or null. Any thread. */
    fun coverReason(): String? = coveredSince(SystemClock.elapsedRealtime())

    /** Why the screen was covered at any moment from counter `sinceMono` until now, or null. */
    fun coveredSince(sinceMono: Long): String? {
        val now = SystemClock.elapsedRealtime()
        return when {
            blanked || blankEnded >= sinceMono -> BLANKED
            testFrom <= now && testUntil >= sinceMono -> TEST
            else -> null
        }
    }

    fun isCover(problem: String?) = problem == BLANKED || problem == TEST

    fun testPatternOn(): Boolean = SystemClock.elapsedRealtime() < testUntil

    private fun blankFile(app: Context) = File(app.filesDir, "blanked")

    /** Reads, once, whether the screen was left blanked (before playback starts). */
    fun load(context: Context) {
        synchronized(lock) {
            if (loaded) return
            loaded = true
            blanked = blankFile(context.applicationContext).exists()
        }
    }

    @Synchronized
    fun start(context: Context, screenId: String, outbox: Outbox) {
        if (runner != null) return
        val app = context.applicationContext
        load(app)
        runner = CommandRunner(
            dir = File(app.filesDir, "commands"),
            screenId = screenId,
            nowMs = { Line.clock.get().now(SystemClock.elapsedRealtime()) },
            actions = Actions(app),
            send = { report, at ->
                outbox.add(report, at)
                Line.nudge()
            },
            log = { Log.i("RecallCommand", it) },
        )
    }

    /** A command from the cloud (the line's thread). */
    fun onCommand(payload: ByteArray) {
        runner?.onCommand(String(payload, Charsets.UTF_8)) ?: Log.w("RecallCommand", "command before the runner started")
    }

    private class Actions(private val app: Context) : CommandActions {
        override fun reboot() {
            // Checked first: a box that cannot restart answers "failed", never "done" (review P2.12).
            if (!Kiosk.isDeviceOwner(app)) error("not device owner: cannot reboot")
            val dpm = app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
            val admin = Kiosk.admin(app)
            main.postDelayed({
                runCatching { dpm.reboot(admin) }.onFailure { CrashLog.record(app, "reboot failed: ${it.javaClass.simpleName}") }
            }, 3_000)
        }

        override fun blank(on: Boolean) {
            val f = blankFile(app)
            synchronized(lock) {
                // On storage for sure before it is answered: bikes lose power without warning.
                if (on) {
                    FileOutputStream(f).use {
                        it.write('1'.code)
                        it.fd.sync()
                    }
                } else if (f.exists() && !f.delete()) {
                    error("the blank could not be undone on storage")
                }
                if (!on && blanked) blankEnded = SystemClock.elapsedRealtime()
                blanked = on
            }
            main.post { Playback.refreshCover() }
        }

        override fun testPattern(seconds: Long) {
            val now = SystemClock.elapsedRealtime()
            testFrom = now
            testUntil = now + seconds * 1_000
            main.post { Playback.refreshCover() }
            main.postDelayed({ Playback.refreshCover() }, seconds * 1_000 + 50)
        }

        override fun brightness(percent: Int?) {
            brightness = percent
        }

        /** The end of the crash log only (it is short, but never read whole on the line's thread). */
        override fun logs(): String {
            val f = CrashLog.file(app)
            val tail = if (!f.exists()) {
                "(no crashes)\n"
            } else {
                RandomAccessFile(f, "r").use { r ->
                    val from = maxOf(0L, r.length() - 3_500)
                    r.seek(from)
                    val bytes = ByteArray((r.length() - from).toInt())
                    r.readFully(bytes)
                    String(bytes, Charsets.UTF_8)
                }
            }
            return "app ${BuildConfig.VERSION_NAME}\n$tail"
        }

        override fun clearCache() {
            app.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
        }
    }
}
