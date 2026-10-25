// P2.12: remote commands on the box. The line hands each command to the runner (core, CommandRunner:
// once only, never expired, answered through the outbox); this is what each one does here.
//  - blank: the screen goes dark over the ads, and stays dark across restarts until "unblank" (a
//    cracked panel, an accident). Nothing shown under it counts: no brand pays for a dark screen.
//  - test pattern: colour bars for the seconds asked; nothing under it counts either.
//  - brightness: a fixed brightness, or automatic again (P2.10); forgotten on restart.
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

object Remote {
    @Volatile private var runner: CommandRunner? = null
    private val main = Handler(Looper.getMainLooper())

    /** Why ads do not count right now (blanked, test pattern), or null. Any thread. */
    @Volatile var blanked = false
        private set
    @Volatile private var testUntil = 0L
    @Volatile var brightness: Int? = null
        private set

    fun coverReason(): String? = when {
        blanked -> "blanked by a command"
        SystemClock.elapsedRealtime() < testUntil -> "test pattern"
        else -> null
    }

    fun testPatternOn(): Boolean = SystemClock.elapsedRealtime() < testUntil

    private fun blankFile(app: Context) = File(app.filesDir, "blanked")

    /** Reads whether the screen was left blanked (main thread, before playback starts). */
    fun load(context: Context) {
        blanked = blankFile(context.applicationContext).exists()
    }

    @Synchronized
    fun start(context: Context, outbox: Outbox) {
        if (runner != null) return
        val app = context.applicationContext
        load(app)
        runner = CommandRunner(
            dir = File(app.filesDir, "commands"),
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
            main.postDelayed({
                runCatching {
                    val dpm = app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
                    dpm.reboot(Kiosk.admin(app))
                }.onFailure { CrashLog.record(app, "reboot failed: ${it.javaClass.simpleName}") }
            }, 3_000)
            if (!Kiosk.isDeviceOwner(app)) error("not device owner: cannot reboot")
        }

        override fun blank(on: Boolean) {
            val f = blankFile(app)
            if (on) f.writeText("1") else f.delete()
            blanked = on
            main.post { Playback.refreshCover() }
        }

        override fun testPattern(seconds: Long) {
            testUntil = SystemClock.elapsedRealtime() + seconds * 1_000
            main.post { Playback.refreshCover() }
            main.postDelayed({ Playback.refreshCover() }, seconds * 1_000 + 50)
        }

        override fun brightness(percent: Int?) {
            brightness = percent
        }

        override fun logs(): String {
            val f = CrashLog.file(app)
            val crashes = if (f.exists()) f.readText() else "(no crashes)\n"
            return "app ${BuildConfig.VERSION_NAME}\n$crashes"
        }

        override fun clearCache() {
            app.cacheDir.listFiles()?.forEach { it.deleteRecursively() }
        }
    }
}
