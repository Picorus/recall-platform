// P2.4: the box's ad files, one store per app process (files/ads). The line hands it each list the
// cloud sends; downloads run on their own thread. Playback (P2.5) asks `store` for an ad's file and
// plays only a file that is here and checked, never a stream.
package app.recall.player

import android.content.Context
import android.os.SystemClock
import app.recall.player.core.AdDownloader
import app.recall.player.core.AdFiles
import app.recall.player.core.AdStore
import app.recall.player.core.HttpsFetcher
import java.io.File
import java.util.concurrent.atomic.AtomicLong

object Ads {
    @Volatile var store: AdStore? = null
        private set
    @Volatile private var downloader: AdDownloader? = null
    /** Lists from the cloud refused whole (should stay 0; health, P2.11). */
    val refusedLists = AtomicLong()

    @Synchronized
    fun start(context: Context) {
        if (store != null) return
        val app = context.applicationContext
        val s = AdStore(File(app.filesDir, "ads"), log = { android.util.Log.i("RecallAds", it) })
        store = s
        downloader = AdDownloader(
            store = s,
            fetcher = HttpsFetcher(),
            // Ended files are judged only by a time the cloud backs (a faked GPS date clears nothing).
            nowSeconds = { Line.clock.get().cloudNow(SystemClock.elapsedRealtime())?.let { it / 1000 } },
            mono = SystemClock::elapsedRealtime,
            log = { android.util.Log.i("RecallAds", it) },
        ).also { it.start() }
    }

    /** A list from the cloud (down/files): remember it and download what is new. */
    fun onList(payload: ByteArray) {
        val list = AdFiles.parse(String(payload))
        if (list.problem != null) {
            refusedLists.incrementAndGet()
            android.util.Log.w("RecallAds", "list refused: ${list.problem}")
            return
        }
        if (store?.want(list.made, list.files) == true) downloader?.nudge()
    }
}
