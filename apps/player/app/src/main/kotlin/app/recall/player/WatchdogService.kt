// P2.2: the watchdog. Runs in its own process, checks the player's heartbeat every second, and starts
// it again when it stops (within 5 seconds), with growing pauses if it keeps crashing. The rules are
// in core (Watchdog.kt) and tested there.
package app.recall.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import app.recall.player.core.WatchdogState
import app.recall.player.core.WatchdogStep

class WatchdogService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var state = WatchdogState()
    private val check = object : Runnable {
        override fun run() {
            val (step, next) = state.check(SystemClock.elapsedRealtime(), Heartbeat.last(this@WatchdogService))
            state = next
            if (step is WatchdogStep.Restart) {
                CrashLog.record(this@WatchdogService, if (step.crashLoop) "restart (crash loop)" else "restart")
                startActivity(
                    Intent(this@WatchdogService, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
                )
            }
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        // A crash here must end this process at once too, so Android starts the watchdog again.
        CrashLog.install(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.watchdog_channel), NotificationManager.IMPORTANCE_MIN),
        )
        val note = Notification.Builder(this, CHANNEL)
            .setContentTitle(getString(R.string.watchdog_running))
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .build()
        startForeground(1, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        // Check at once: if the whole app went down (the watchdog too), Android restarts this service
        // about a second later, and the player's heartbeat is already old by then.
        handler.post(check)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

    override fun onDestroy() {
        handler.removeCallbacks(check)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private companion object {
        const val CHANNEL = "watchdog"
    }
}
