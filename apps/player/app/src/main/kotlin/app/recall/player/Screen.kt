// P2.5.2: the screen itself. Two layers the size of the screen, one in front showing, one behind
// loading the next spot (Renderer.prepare): a video is opened and its first frame drawn, a picture is
// decoded, ahead of time. At the spot's second (Renderer.show) the back layer comes to the front and
// the video starts, so the swap takes one frame: no gap, no black. Every spot is confirmed only once
// it is really on screen (ScreenReports.started); a file that will not open is reported, and is
// downloaded again (P2.4). Files come from the ad store only, never a stream; no sound.
//
// The conductor calls from its own thread; everything here runs on the main thread (the video player
// and views must be used from there).
package app.recall.player

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.TextureView
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import app.recall.player.core.MediaKind
import app.recall.player.core.MediaKinds
import app.recall.player.core.Renderer
import app.recall.player.core.ScreenReports
import app.recall.player.core.Spot
import java.io.File
import java.util.concurrent.Executors

/** Must be made on the main thread. */
class Screen(private val context: Context, private val root: FrameLayout) : Renderer {
    /** Who hears about each spot (the conductor playing now). */
    @Volatile var reports: ScreenReports? = null

    private val main = Handler(Looper.getMainLooper())
    /** Pictures are decoded off the main thread. */
    private val decoder = Executors.newSingleThreadExecutor { Thread(it, "recall-decode").apply { isDaemon = true } }
    private val decks = listOf(Deck(), Deck())
    /** The deck in front (main thread only). */
    private var front = 0

    init {
        check(Looper.myLooper() == Looper.getMainLooper()) { "make the screen on the main thread" }
        decks.forEach { root.addView(it.view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)) }
        decks[front].view.bringToFront()
    }

    override fun prepare(spot: Spot) {
        main.post { decks[1 - front].load(spot) }
    }

    override fun show(spot: Spot) {
        main.post {
            var i = decks.indexOfFirst { it.spot === spot }
            if (i < 0) {
                // Not loaded ahead (should not happen): load it behind now and show it at once.
                i = 1 - front
                decks[i].load(spot)
            }
            front = i
            decks[i].show()
            decks[1 - i].hide()
        }
    }

    /** Frees the video players (when the screen goes away). */
    fun release() {
        main.post { decks.forEach { it.player.release() } }
        decoder.shutdown()
    }

    private inner class Deck {
        val view = FrameLayout(context).apply { setBackgroundColor(MIDNIGHT) }
        private val texture = TextureView(context)
        private val picture = ImageView(context).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
        private val slate = TextView(context).apply {
            text = context.getString(R.string.app_name)
            setTextColor(VOLT)
            gravity = Gravity.CENTER
            textSize = 32f
        }
        val player: ExoPlayer = ExoPlayer.Builder(context).build().apply {
            volume = 0f
            setVideoTextureView(texture)
            addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    firstFrame = true
                    if (shown) spot?.let { reports?.started(it) }
                }

                override fun onPlayerError(error: PlaybackException) {
                    // A file that cannot be read or decoded is the file's fault; anything else the screen's.
                    val fileFault = error.errorCode in 3000..4999
                    spot?.let { reports?.failed(it, "video: ${error.errorCodeName}", fileFault) }
                }
            })
        }

        /** What this deck holds, and how far it got (main thread only). */
        var spot: Spot? = null
        private var loads = 0
        private var shown = false
        private var firstFrame = false
        private var pictureReady = false
        private var kind: MediaKind? = null

        init {
            listOf(texture, picture, slate).forEach {
                view.addView(it, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
                it.visibility = View.INVISIBLE
            }
        }

        fun load(next: Spot) {
            val load = ++loads
            spot = next
            shown = false
            firstFrame = false
            pictureReady = false
            kind = null
            player.stop()
            player.clearMediaItems()
            picture.setImageDrawable(null)
            val file = next.file
            if (file == null) {
                only(slate)
                return
            }
            decoder.execute {
                val k = MediaKinds.of(file)
                val bitmap = if (k == MediaKind.PICTURE) decode(file) else null
                main.post {
                    if (load != loads) return@post // a newer spot was loaded meanwhile
                    kind = k
                    if (k == MediaKind.VIDEO) {
                        only(texture)
                        player.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
                        player.playWhenReady = shown
                        player.prepare()
                    } else if (bitmap == null) {
                        reports?.failed(next, "picture: cannot be read", fileFault = true)
                    } else {
                        only(picture)
                        picture.setImageBitmap(bitmap)
                        pictureReady = true
                        if (shown) reports?.started(next)
                    }
                }
            }
        }

        fun show() {
            shown = true
            view.bringToFront()
            val s = spot ?: return
            when {
                s.file == null -> reports?.started(s) // the slate
                kind == MediaKind.VIDEO -> {
                    player.play()
                    if (firstFrame) reports?.started(s)
                }
                kind == MediaKind.PICTURE && pictureReady -> reports?.started(s)
                // Still loading: confirmed when its picture or first frame arrives.
            }
        }

        fun hide() {
            shown = false
            player.pause()
        }

        private fun only(v: View) = listOf(texture, picture, slate).forEach { it.visibility = if (it === v) View.VISIBLE else View.INVISIBLE }

        /** The picture, scaled down to the screen if larger (never up). Null when it cannot be read. */
        private fun decode(file: File) = runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val m = context.resources.displayMetrics
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= m.widthPixels && bounds.outHeight / (sample * 2) >= m.heightPixels) sample *= 2
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        }.getOrNull()
    }

    companion object {
        /** Night Signal colours: midnight ground, volt wordmark (RECALL's own slate). */
        val MIDNIGHT = Color.rgb(0x0A, 0x0E, 0x17)
        val VOLT = Color.rgb(0xC8, 0xF5, 0x4A)
    }
}
