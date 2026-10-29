// P2.5.2: the screen itself. Two layers the size of the screen, one in front showing, one behind
// loading the next spot (Renderer.prepare): a video is opened and its first frame drawn, a picture is
// decoded, ahead of time. At the spot's second (Renderer.show) the back layer comes to the front and
// the video starts, so the swap takes one frame: no gap, no black. Files come from the ad store only,
// never a stream; no sound (audio is not even decoded).
//
// Each spot is confirmed (ScreenReports.started) only once its first frame or picture is on screen,
// within half a second of its swap; later than that it is reported as a late start and does not count.
// A layer still loading, or whose file failed, shows RECALL's slate, never what it held before.
// A blank spot (outside our zone, P2.5) is a black frame: no file, nothing to load, not a play.
// A file the player cannot read is reported as the file's fault (the store checks it again and
// downloads it again only if it is really damaged); a box problem is reported as the screen's.
//
// The conductor calls from its own thread; everything here runs on the main thread (the video player
// and views must be used from there).
package app.recall.player

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.TextureView
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.media3.common.C
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
class Screen(
    private val context: Context,
    private val root: FrameLayout,
    /** Why ads must not count now (blanked, test pattern, P2.12), or null. */
    private val cover: () -> String? = { null },
    /** True while the test pattern shows (else the cover is dark). */
    private val testPattern: () -> Boolean = { false },
) : Renderer {
    // First, before any player is built: players belong to the thread that makes them.
    private val mainThreadOnly = check(Looper.myLooper() == Looper.getMainLooper()) { "make the screen on the main thread" }

    /** Who hears about each spot (the conductor playing now). */
    @Volatile var reports: ScreenReports? = null

    private val main = Handler(Looper.getMainLooper())
    /** Pictures are decoded off the main thread. */
    private val decoder = Executors.newSingleThreadExecutor { Thread(it, "recall-decode").apply { isDaemon = true } }
    private val decks = listOf(Deck(), Deck())
    /** The deck in front, and whether the screen was released (main thread only). */
    private var front = 0
    private var released = false

    /** Over everything while a command blanks the screen or shows the test pattern (P2.12). */
    private val dark = View(context).apply {
        setBackgroundColor(Color.BLACK)
        visibility = View.GONE
    }
    private val bars = android.widget.LinearLayout(context).apply {
        orientation = android.widget.LinearLayout.HORIZONTAL
        visibility = View.GONE
        for (c in listOf(Color.WHITE, Color.YELLOW, Color.CYAN, Color.GREEN, Color.MAGENTA, Color.RED, Color.BLUE, Color.BLACK)) {
            addView(View(context).apply { setBackgroundColor(c) }, android.widget.LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
        }
    }

    init {
        decks.forEach { root.addView(it.view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)) }
        decks[front].view.bringToFront()
        root.addView(dark, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(bars, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        refreshCover()
    }

    /** Shows or hides the cover as the commands say (main thread). */
    fun refreshCover() {
        if (released) return
        val reason = cover()
        val test = reason != null && testPattern()
        bars.visibility = if (test) View.VISIBLE else View.GONE
        dark.visibility = if (reason != null && !test) View.VISIBLE else View.GONE
        dark.bringToFront()
        bars.bringToFront()
        // The spot showing when a cover comes never counts either (the conductor checks too).
        if (reason != null) decks[front].covered(reason)
    }

    /** Runs on the main thread, unless the screen has been released meanwhile. */
    private fun onMain(work: () -> Unit) {
        main.post { if (!released) work() }
    }

    override fun prepare(spot: Spot) = onMain { decks[1 - front].load(spot) }

    override fun show(spot: Spot) = onMain {
        var i = decks.indexOfFirst { it.spot === spot }
        if (i < 0) {
            // Not loaded ahead (should not happen): load it behind now and show it at once.
            i = 1 - front
            decks[i].load(spot)
        }
        front = i
        decks[i].show()
        decks[1 - i].hide()
        refreshCover()

    }

    /** Frees the video players and the decoder (when the screen goes away). */
    fun release() {
        main.post {
            released = true
            decks.forEach { it.release() }
            decoder.shutdown()
        }
    }

    private inner class Deck {
        val view = FrameLayout(context).apply { setBackgroundColor(MIDNIGHT) }
        private val texture = TextureView(context)
        // On its own ground, so nothing of the video layer under it shows round a picture.
        private val picture = ImageView(context).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
            setBackgroundColor(MIDNIGHT)
        }
        /** Outside our zone (P2.5): a black frame, nothing else. */
        private val black = View(context).apply { setBackgroundColor(Color.BLACK) }
        private val slate = TextView(context).apply {
            text = context.getString(R.string.app_name)
            setTextColor(VOLT)
            setBackgroundColor(MIDNIGHT)
            gravity = Gravity.CENTER
            textSize = 32f
        }

        /** What this deck holds, and how far it got (main thread only). */
        var spot: Spot? = null
        private var loads = 0
        /** One player per video spot: nothing from an earlier video can reach a later spot. */
        private var player: ExoPlayer? = null
        private var shownAt = -1L
        private var ready = false
        private var confirmed = false

        init {
            // Bottom to top: video, picture, slate, black.
            listOf(texture, picture, slate, black).forEach { view.addView(it, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)) }
            only(slate)
        }

        fun load(next: Spot) {
            val load = ++loads
            spot = next
            shownAt = -1L
            ready = false
            confirmed = false
            player?.release()
            player = null
            picture.setImageDrawable(null)
            // Until this spot's own picture or frame is ready: the slate, never what was here before.
            only(slate)
            if (next.blank) {
                // Outside our zone: black, no file (not a play: the conductor never hands it on).
                only(black)
                ready = true
                return
            }
            val file = next.file
            if (file == null) {
                ready = true
                return
            }
            val work = Runnable {
                val kind = MediaKinds.of(file)
                val decoded = if (kind == MediaKind.PICTURE) decode(file) else null
                onMain {
                    if (load != loads) return@onMain // a newer spot was loaded meanwhile
                    when {
                        kind == MediaKind.VIDEO -> openVideo(next, file, load)
                        decoded is Bitmap -> {
                            picture.setImageBitmap(decoded)
                            only(picture)
                            ready = true
                            if (shownAt >= 0) confirm()
                        }
                        else -> fail(next, "picture: ${decoded ?: "cannot be read"}", fileFault = decoded == null)
                    }
                }
            }
            runCatching { decoder.execute(work) }.onFailure { fail(next, "screen closing", fileFault = false) }
        }

        private fun openVideo(next: Spot, file: File, load: Int) {
            val p = ExoPlayer.Builder(context).build()
            player = p
            p.volume = 0f
            // No sound on the screen: do not even decode it (saves the box's processor).
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, true)
                .build()
            p.setVideoTextureView(texture)
            p.addListener(object : Player.Listener {
                override fun onRenderedFirstFrame() {
                    if (load != loads) return
                    only(texture)
                    ready = true
                    if (shownAt >= 0) confirm()
                }

                override fun onPlayerError(error: PlaybackException) {
                    if (load != loads) return
                    val code = error.errorCode
                    when {
                        code in FILE_FAULTS -> fail(next, "video: ${error.errorCodeName}", fileFault = true)
                        // The box cannot play this kind of video at all: a health signal, not a download.
                        code in UNSUPPORTED -> fail(next, "video unsupported on this box: ${error.errorCodeName}", fileFault = false)
                        else -> fail(next, "screen: ${error.errorCodeName}", fileFault = false)
                    }
                }
            })
            p.setMediaItem(MediaItem.fromUri(Uri.fromFile(file)))
            p.playWhenReady = shownAt >= 0
            p.prepare()
        }

        fun show() {
            shownAt = SystemClock.uptimeMillis()
            view.bringToFront()
            player?.play()
            if (ready) confirm()
            // Still loading: confirmed when its picture or first frame arrives (if in time).
        }

        /** The spot showing is under a cover: reported as not shown, never confirmed. */
        fun covered(reason: String) {
            val s = spot ?: return
            if (shownAt < 0 || coveredLoad == loads) return // not showing, or already reported
            coveredLoad = loads
            confirmed = true
            reports?.failed(s, reason, fileFault = false)
        }
        private var coveredLoad = -1

        fun hide() {
            shownAt = -1L
            player?.pause()
        }

        fun release() {
            player?.release()
            player = null
        }

        /** Confirms the spot once the next frame is drawn, if that is within half a second of its swap. */
        private fun confirm() {
            if (confirmed) return
            confirmed = true
            val s = spot ?: return
            val load = loads
            view.postOnAnimation {
                if (released || load != loads || shownAt < 0) return@postOnAnimation
                val late = SystemClock.uptimeMillis() - shownAt
                if (late <= LATE_MS) reports?.started(s) else reports?.failed(s, "late start: $late ms after the swap", fileFault = false)
            }
        }

        private fun fail(s: Spot, problem: String, fileFault: Boolean) {
            only(slate)
            player?.release()
            player = null
            ready = false
            confirmed = true // nothing to confirm: this spot does not count
            reports?.failed(s, problem, fileFault)
        }

        /**
         * Shows one of the three. The video layer stays visible underneath at all times (Android makes
         * its drawing surface only once it is visible: hidden, a video could never draw its first frame);
         * the picture or the slate cover it until the video's own first frame is there.
         */
        private fun only(v: View) {
            picture.visibility = if (v === picture) View.VISIBLE else View.INVISIBLE
            slate.visibility = if (v === slate) View.VISIBLE else View.INVISIBLE
            black.visibility = if (v === black) View.VISIBLE else View.INVISIBLE
        }

        /**
         * The picture, scaled down to the screen if larger (never up). A String says why the box could
         * not (out of memory: the box's fault); null: the file cannot be read (the file's fault).
         */
        private fun decode(file: File): Any? = try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val m = context.resources.displayMetrics
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= m.widthPixels && bounds.outHeight / (sample * 2) >= m.heightPixels) sample *= 2
            BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        } catch (e: OutOfMemoryError) {
            "out of memory"
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        /** Night Signal colours: midnight ground, volt wordmark (RECALL's own slate). */
        val MIDNIGHT = Color.rgb(0x0A, 0x0E, 0x17)
        val VOLT = Color.rgb(0xC8, 0xF5, 0x4A)

        /** A spot confirmed later than this after its swap did not really show from its start. */
        const val LATE_MS = 500L

        /** Errors that mean the file itself is bad (cut short, not a video, cannot be decoded). */
        private val FILE_FAULTS = setOf(
            PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
            PlaybackException.ERROR_CODE_DECODING_FAILED,
        )

        /** The box cannot play this format at all (e.g. too large, or an unknown codec). */
        private val UNSUPPORTED = setOf(
            PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
        )
    }
}
