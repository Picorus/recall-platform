package app.recall.player.core

import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertNotNull

class AdDownloaderTest {
    private fun until(what: String, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!ok()) {
            check(System.currentTimeMillis() < end) { "timed out waiting for: $what" }
            Thread.sleep(10)
        }
    }

    @Test
    fun `downloads in the background as soon as a list comes, and keeps going after a failure`() {
        val content = Random(2).nextBytes(5_000)
        val sha = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        val store = AdStore(Files.createTempDirectory("ads").toFile(), AdStoreRules(firstRetryMs = 1, lastRetryMs = 1))
        val calls = AtomicInteger()
        val fetcher = Fetcher { _, _ ->
            if (calls.incrementAndGet() == 1) throw Error("something unexpected")
            Fetched(0, ByteArrayInputStream(content))
        }
        var mono = 0L
        val d = AdDownloader(store, fetcher, nowSeconds = { null }, mono = { mono++ }, everyMs = 60_000)
        d.start()
        try {
            store.want(1, listOf(AdFile("A", sha, content.size.toLong(), "https://files.recall.example/A", 1_790_000_000L)))
            d.nudge()
            until("the first try failed") { calls.get() >= 1 }
            Thread.sleep(50)
            d.nudge()
            until("downloaded") { store.file("A") != null }
            assertNotNull(store.file("A"))
        } finally {
            d.stop()
        }
    }
}
