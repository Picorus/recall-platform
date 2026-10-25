// Debug builds only: an empty full-screen layout the playback checks draw on (P2.5.2), so they test
// the screen without the kiosk, the line or the watchdog.
package app.recall.player

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

class PlaybackTestActivity : Activity() {
    lateinit var root: FrameLayout
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        setContentView(root)
    }
}
