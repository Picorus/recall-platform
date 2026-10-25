// P2.2: the player's one screen. Full screen, kept on, locked to the player; it beats every second so
// the watchdog knows it is alive. It also starts the line to the cloud (P2.3.3). Playback comes in
// P2.5; for now it shows the screen is up.
package app.recall.player

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.TextView

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
        setContentView(
            TextView(this).apply {
                text = getString(R.string.app_name)
                setTextColor(Color.rgb(0xC8, 0xF5, 0x4A)) // Night Signal volt
                setBackgroundColor(Color.rgb(0x0A, 0x0E, 0x17)) // midnight
                gravity = Gravity.CENTER
                textSize = 32f
            },
        )
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
        super.onDestroy()
    }
}
