package app.recall.player

import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.recall.player.core.ScreenReports
import app.recall.player.core.Spot
import app.recall.player.core.SpotChoice
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * P2.5.2 on a real Android: the screen loads the next spot behind the one showing and swaps at once.
 * Each spot is loaded 2 s ahead (as the conductor does), then shown; it must be confirmed on screen
 * within 150 ms of the swap (one or two frames), video and picture alike. A broken file is reported.
 */
@RunWith(AndroidJUnit4::class)
class ScreenTest {
    private class Heard(val what: String, val spot: Spot, val at: Long, val fileFault: Boolean = false)

    private val heard = CopyOnWriteArrayList<Heard>()
    private val reports = object : ScreenReports {
        override fun started(spot: Spot) {
            heard += Heard("started", spot, SystemClock.elapsedRealtime())
        }

        override fun failed(spot: Spot, problem: String, fileFault: Boolean) {
            heard += Heard("failed: $problem", spot, SystemClock.elapsedRealtime(), fileFault)
        }
    }
    private lateinit var scenario: ActivityScenario<PlaybackTestActivity>
    private lateinit var screen: Screen

    private fun asset(name: String): File {
        val ctx = InstrumentationRegistry.getInstrumentation()
        val out = File(ctx.targetContext.cacheDir, name)
        ctx.context.assets.open(name).use { input -> out.outputStream().use { input.copyTo(it) } }
        return out
    }

    private fun spot(ad: String, file: File?) = Spot(null, null, null, null, null, file?.let { SpotChoice("recall", null, ad) }, file)

    @Before
    fun open() {
        scenario = ActivityScenario.launch(PlaybackTestActivity::class.java)
        scenario.onActivity {
            screen = Screen(it, it.root)
            screen.reports = reports
        }
    }

    @After
    fun close() {
        screen.release()
        scenario.close()
    }

    /** Loads ahead, shows, and returns how long after the swap the spot was confirmed on screen. */
    private fun loadAndShow(s: Spot): Long {
        screen.prepare(s)
        SystemClock.sleep(2_000)
        val shownAt = SystemClock.elapsedRealtime()
        screen.show(s)
        val end = shownAt + 3_000
        while (SystemClock.elapsedRealtime() < end) {
            heard.firstOrNull { it.spot === s }?.let {
                assertEquals("started", it.what)
                return it.at - shownAt
            }
            SystemClock.sleep(5)
        }
        throw AssertionError("not confirmed on screen within 3 s: ${s.shows?.ad}")
    }

    @Test
    fun videoPictureVideoAndSlateSwapWithoutGaps() {
        val video = asset("ad-video.mp4")
        val picture = asset("ad-picture.png")
        val delays = listOf(
            loadAndShow(spot("video", video)),
            loadAndShow(spot("picture", picture)),
            loadAndShow(spot("video-again", video)),
            loadAndShow(spot("slate", null)),
            loadAndShow(spot("video-after-slate", video)),
        )
        assertTrue("confirmed after the swap (ms): $delays", delays.all { it in 0..150 })
    }

    @Test
    fun aBrokenFileIsReportedAsTheFilesFault() {
        val broken = spot("broken", asset("broken.bin"))
        screen.prepare(broken)
        val end = SystemClock.elapsedRealtime() + 10_000
        while (heard.none { it.spot === broken } && SystemClock.elapsedRealtime() < end) SystemClock.sleep(20)
        val h = heard.firstOrNull { it.spot === broken } ?: throw AssertionError("a broken file was not reported")
        assertTrue(h.what, h.what.startsWith("failed"))
        assertTrue("reported as the file's fault", h.fileFault)
        // The screen carries on: the next spot still shows.
        assertTrue(loadAndShow(spot("picture", asset("ad-picture.png"))) in 0..150)
    }
}
