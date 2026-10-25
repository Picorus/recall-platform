// P2.2: the player's one screen. Full screen, kept on, locked to the player; it beats every second so
// the watchdog knows it is alive. It also starts the line to the cloud (P2.3.3) and playback (P2.5).
package app.recall.player

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout

class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val beat = object : Runnable {
        override fun run() {
            Heartbeat.beat(this@MainActivity)
            main.postDelayed(this, 1_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.install(this)
        Kiosk.applyPolicies(this)
        // The line to the cloud (P2.3.3): keeps itself open; a failure to start never stops the screen.
        Line.startInBackground(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val root = FrameLayout(this).apply { setBackgroundColor(Screen.MIDNIGHT) }
        setContentView(root)
        // Playback (P2.5): RECALL's slate until there is something to play; never a dark screen.
        Playback.start(this, root)
    }

    override fun onResume() {
        super.onResume()
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        Kiosk.lock(this)
        startForegroundService(Intent(this, WatchdogService::class.java))
        main.removeCallbacks(beat)
        main.post(beat)
    }

    override fun onDestroy() {
        main.removeCallbacks(beat)
        Playback.stop(this)
        super.onDestroy()
    }
}
