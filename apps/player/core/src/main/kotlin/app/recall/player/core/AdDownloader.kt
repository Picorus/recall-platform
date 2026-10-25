// P2.4: keeps the ad files coming down in the background, on its own thread (a large download must
// never hold up the line or the screen). It first checks the files already on the box, then
// downloads what is missing whenever the cloud sends a new list, and every few minutes anyway (a
// failed download is tried again after its wait).
package app.recall.player.core

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class AdDownloader(
    private val store: AdStore,
    private val fetcher: Fetcher,
    /** A time the cloud backs (UTC s), or null while there is none (TrustedClock.cloudNow). */
    private val nowSeconds: () -> Long?,
    /** The monotonic counter, ms. */
    private val mono: () -> Long,
    private val log: (String) -> Unit = {},
    private val everyMs: Long = 60_000,
) {
    private val wake = LinkedBlockingQueue<Boolean>()
    @Volatile private var running = false
    private var thread: Thread? = null

    @Synchronized
    fun start() {
        if (running) return
        running = true
        thread = Thread(::run, "recall-ads").apply {
            isDaemon = true
            start()
        }
    }

    @Synchronized
    fun stop(waitMs: Long = 5_000) {
        running = false
        wake.offer(false)
        thread?.interrupt()
        thread?.join(waitMs)
    }

    /** The cloud sent a list (already handed to the store): download now. */
    fun nudge() {
        wake.offer(true)
    }

    private fun run() {
        runCatching { store.checkAll() }.onFailure { log("ads: check failed: ${it.message}") }
        while (running) {
            try {
                store.fetchMissing(fetcher, nowSeconds(), mono())
            } catch (e: Throwable) {
                // Anything, even an Error: downloads must keep going, never die quietly.
                log("ads: ${e.javaClass.simpleName}: ${e.message}")
            }
            if (!running) break
            try {
                wake.poll(everyMs, TimeUnit.MILLISECONDS)
            } catch (_: InterruptedException) {
                break
            }
        }
    }
}
