package app.recall.player.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AdStoreTest {
    private val dir = Files.createTempDirectory("ads").toFile()
    private val t0 = 1_790_000_000L
    private val free = AtomicLong(100L * 1024 * 1024 * 1024)
    private val rules = AdStoreRules(maxBytes = 1_000_000, keepFreeBytes = 0, firstRetryMs = 1_000, lastRetryMs = 8_000)

    private fun store(r: AdStoreRules = rules) = AdStore(dir, r, freeBytes = { free.get() })

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    private fun bytes(n: Int, seed: Int) = Random(seed).nextBytes(n)

    private fun ad(id: String, content: ByteArray, keepUntil: Long = t0 + 3_600) =
        AdFile(id, sha(content), content.size.toLong(), "https://files.recall.example/$id", keepUntil)

    /** Storage as the box sees it: serves files, carries on from a byte when asked, can misbehave. */
    inner class FakeStorage(val content: Map<String, ByteArray>) : Fetcher {
        val calls = mutableListOf<Pair<String, Long>>()
        /** Drop the line after this many bytes (once). */
        var dropAfter: Int? = null
        var ignoreRange = false
        var down = false

        override fun fetch(url: String, from: Long): Fetched {
            calls += url to from
            if (down) throw IOException("no signal")
            val all = content.getValue(url.substringAfterLast('/').substringBefore('?'))
            val start = if (ignoreRange) 0 else from.toInt()
            val rest = all.copyOfRange(start, all.size)
            val cut = dropAfter
            dropAfter = null
            val body: InputStream = if (cut == null) ByteArrayInputStream(rest) else object : InputStream() {
                var i = 0
                override fun read(): Int {
                    if (i >= cut) throw IOException("line dropped")
                    return if (i < rest.size) rest[i++].toInt() and 0xff else -1
                }
            }
            return Fetched(start.toLong(), body)
        }
    }

    @Test
    fun `downloads ahead, checks the fingerprint, and plays only a whole checked file`() {
        val a = bytes(50_000, 1)
        val b = bytes(20_000, 2)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a), ad("B", b)))
        assertNull(s.file("A"), "nothing to play before it is downloaded (never streamed)")
        assertEquals(2, s.fetchMissing(FakeStorage(mapOf("A" to a, "B" to b)), t0, 0))
        assertContentEquals(a, assertNotNull(s.file("A")).readBytes())
        assertContentEquals(b, assertNotNull(s.file("B")).readBytes())
        assertNull(s.file("C"))
        assertTrue(s.missing(t0).isEmpty())
    }

    @Test
    fun `a download cut short carries on from where it stopped`() {
        val a = bytes(300_000, 3)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a)))
        val storage = FakeStorage(mapOf("A" to a)).apply { dropAfter = 120_000 }
        assertEquals(0, s.fetchMissing(storage, t0, 0))
        assertNull(s.file("A"))
        // It got further: a weak link, not a bad file, so no growing wait before the next run.
        assertEquals(1, s.fetchMissing(storage, t0, 1))
        assertEquals(listOf("https://files.recall.example/A" to 0L, "https://files.recall.example/A" to 120_000L), storage.calls)
        assertContentEquals(a, assertNotNull(s.file("A")).readBytes())
        assertEquals(0L, s.badFiles)
    }

    @Test
    fun `a server that starts again from the top is fine too`() {
        val a = bytes(100_000, 4)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a)))
        val storage = FakeStorage(mapOf("A" to a)).apply { dropAfter = 40_000 }
        s.fetchMissing(storage, t0, 0)
        storage.ignoreRange = true
        assertEquals(1, s.fetchMissing(storage, t0, 10_000))
        assertContentEquals(a, assertNotNull(s.file("A")).readBytes())
    }

    @Test
    fun `a wrong file is thrown away, counted, and never played`() {
        val a = bytes(10_000, 5)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a)))
        val wrong = a.copyOf().also { it[5_000] = (it[5_000] + 1).toByte() }
        assertEquals(0, s.fetchMissing(FakeStorage(mapOf("A" to wrong)), t0, 0))
        assertNull(s.file("A"))
        assertEquals(1L, s.badFiles)
        assertTrue(File(dir, "files").listFiles()!!.isEmpty(), "nothing of it is kept")
        // Bigger than the list says: stopped at the limit.
        assertEquals(0, s.fetchMissing(FakeStorage(mapOf("A" to a + a)), t0, 60_000))
        assertEquals(2L, s.badFiles)
        assertEquals(1, s.fetchMissing(FakeStorage(mapOf("A" to a)), t0, 120_000))
    }

    @Test
    fun `waits grow after each failure, and a fresh link is tried at once`() {
        val a = bytes(1_000, 6)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a)))
        val storage = FakeStorage(mapOf("A" to a)).apply { down = true }
        s.fetchMissing(storage, t0, 0) // fails: next try at 1 s
        s.fetchMissing(storage, t0, 1_000) // fails: next at 3 s
        s.fetchMissing(storage, t0, 2_000) // waiting
        s.fetchMissing(storage, t0, 3_000) // fails: next at 7 s
        assertEquals(3, storage.calls.size)
        s.want(t0 * 1000, listOf(ad("A", a).copy(url = "https://files.recall.example/A?fresh")))
        storage.down = false
        assertEquals(1, s.fetchMissing(storage, t0, 3_001))
    }

    @Test
    fun `keeps files until the booking ends, and clears ended ones only when room is needed`() {
        val old = bytes(400_000, 7)
        val mid = bytes(300_000, 8)
        val new = bytes(400_000, 9)
        val s = store()
        s.want(t0 * 1000, listOf(ad("OLD", old, keepUntil = t0 + 100), ad("MID", mid, keepUntil = t0 + 200)))
        s.fetchMissing(FakeStorage(mapOf("OLD" to old, "MID" to mid)), t0, 0)
        // Both ended, but there is room: they stay (a renewed booking needs no download).
        s.fetchMissing(FakeStorage(emptyMap()), t0 + 500, 0)
        assertNotNull(s.file("OLD"))
        // A new file needs room: the one that ended longest ago goes first, and only as much as needed.
        s.want(t0 * 1000 + 1, listOf(ad("OLD", old, keepUntil = t0 + 100), ad("MID", mid, keepUntil = t0 + 200), ad("NEW", new, keepUntil = t0 + 5_000)))
        assertEquals(1, s.fetchMissing(FakeStorage(mapOf("NEW" to new)), t0 + 500, 0))
        assertNull(s.file("OLD"))
        assertNotNull(s.file("MID"))
        assertNotNull(s.file("NEW"))
        assertEquals(1L, s.cleared)
    }

    @Test
    fun `a file still needed is never cleared, and no room is reported`() {
        val a = bytes(600_000, 10)
        val b = bytes(600_000, 11)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a, keepUntil = t0 + 1_000)))
        s.fetchMissing(FakeStorage(mapOf("A" to a)), t0, 0)
        s.want(t0 * 1000 + 1, listOf(ad("A", a, keepUntil = t0 + 1_000), ad("B", b, keepUntil = t0 + 1_000)))
        assertEquals(0, s.fetchMissing(FakeStorage(mapOf("B" to b)), t0, 0))
        assertNotNull(s.file("A"))
        assertNull(s.file("B"))
        assertEquals(1L, s.noRoom)
        // The disk filling up from elsewhere counts too.
        free.set(0)
        val c = bytes(10, 12)
        s.want(t0 * 1000 + 2, listOf(ad("A", a, keepUntil = t0 + 1_000), ad("C", c, keepUntil = t0 + 1_000)))
        assertEquals(0, s.fetchMissing(FakeStorage(mapOf("C" to c)), t0, 0))
        assertNotNull(s.file("A"))
    }

    @Test
    fun `without a time the cloud backs, nothing counts as ended`() {
        val a = bytes(600_000, 13)
        val b = bytes(600_000, 14)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a, keepUntil = t0)))
        s.fetchMissing(FakeStorage(mapOf("A" to a)), null, 0)
        s.want(t0 * 1000 + 1, listOf(ad("A", a, keepUntil = t0), ad("B", b, keepUntil = t0 + 1_000)))
        assertEquals(0, s.fetchMissing(FakeStorage(mapOf("B" to b)), null, 0))
        assertNotNull(s.file("A"), "an ended file is cleared only by a trusted time")
        assertEquals(1, s.fetchMissing(FakeStorage(mapOf("B" to b)), t0 + 1, 0))
        assertNull(s.file("A"))
    }

    @Test
    fun `each list is the whole list - an older one is ignored, a newer one can cut a booking short`() {
        val a = bytes(1_000, 15)
        val a2 = bytes(1_000, 16)
        val s = store()
        assertTrue(s.want(t0 * 1000 + 5, listOf(ad("A", a, keepUntil = t0 + 900))))
        assertTrue(!s.want(t0 * 1000 + 4, listOf(ad("A", a, keepUntil = t0 + 100))), "older: ignored")
        s.fetchMissing(FakeStorage(mapOf("A" to a)), t0 + 500, 0)
        assertNotNull(s.file("A"), "still kept until t0 + 900")
        // A new file for the ad: the old one is never played for it.
        s.want(t0 * 1000 + 6, listOf(ad("A", a2)))
        assertNull(s.file("A"))
        s.fetchMissing(FakeStorage(mapOf("A" to a2)), t0, 0)
        assertContentEquals(a2, assertNotNull(s.file("A")).readBytes())
        // Left off the next list (booking cancelled): no longer played, and its space can be used.
        s.want(t0 * 1000 + 7, emptyList())
        assertNull(s.file("A"))
        val big = bytes(999_500, 23)
        s.want(t0 * 1000 + 8, listOf(ad("BIG", big)))
        assertEquals(1, s.fetchMissing(FakeStorage(mapOf("BIG" to big)), null, 0), "unlisted files go even with no time known")
        assertEquals(2L, s.cleared, "both old files, to fit the big one")
    }

    @Test
    fun `after a restart the last time the cloud backed still counts`() {
        val a = bytes(600_000, 24)
        val b = bytes(600_000, 25)
        val first = store()
        first.want(t0 * 1000, listOf(ad("A", a, keepUntil = t0 + 100), ad("B", b, keepUntil = t0 + 10_000)))
        first.fetchMissing(FakeStorage(mapOf("A" to a)), t0 + 200, 0) // A ended, but it was never here
        // Powered off and on: no cloud time yet, but the box knows it is at least t0 + 200.
        val again = store()
        assertEquals(listOf("B"), again.missing(null).map { it.ad })
        val storage = FakeStorage(mapOf("A" to a, "B" to b))
        assertEquals(1, again.fetchMissing(storage, null, 0))
        assertEquals(listOf("https://files.recall.example/B" to 0L), storage.calls, "no download for what has ended")
    }

    @Test
    fun `two ads with the same file download it once`() {
        val a = bytes(5_000, 17)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a), ad("B", a).copy(url = "https://files.recall.example/A")))
        val storage = FakeStorage(mapOf("A" to a))
        assertEquals(1, s.fetchMissing(storage, t0, 0))
        assertEquals(1, storage.calls.size)
        assertEquals(s.file("A"), s.file("B"))
    }

    @Test
    fun `after a restart the list and the files are still there, and damaged files are found`() {
        val a = bytes(30_000, 18)
        val b = bytes(30_000, 19)
        val first = store()
        first.want(t0 * 1000, listOf(ad("A", a), ad("B", b)))
        first.fetchMissing(FakeStorage(mapOf("A" to a, "B" to b)), t0, 0)
        // Storage damaged while the box was off: same size, different bytes.
        val bf = assertNotNull(first.file("B"))
        bf.writeBytes(bytes(30_000, 99))
        File(dir, "files/${"0".repeat(64)}.part").writeText("nobody wants this")
        File(dir, "wanted.tmp").writeText("half written")

        val again = store()
        assertNull(again.file("A"), "not played until checked again")
        assertEquals(1, again.checkAll())
        assertNotNull(again.file("A"))
        assertNull(again.file("B"))
        assertEquals(1L, again.badFiles)
        assertEquals(listOf("B"), again.missing(t0).map { it.ad })
        assertTrue(!File(dir, "files/${"0".repeat(64)}.part").exists())
        assertEquals(1, again.fetchMissing(FakeStorage(mapOf("B" to b)), t0, 0))
        assertContentEquals(b, assertNotNull(again.file("B")).readBytes())
    }

    @Test
    fun `a half download survives a restart and carries on`() {
        val a = bytes(200_000, 20)
        val first = store()
        first.want(t0 * 1000, listOf(ad("A", a)))
        first.fetchMissing(FakeStorage(mapOf("A" to a)).apply { dropAfter = 150_000 }, t0, 0)
        val again = store()
        val storage = FakeStorage(mapOf("A" to a))
        assertEquals(1, again.fetchMissing(storage, t0, 0))
        assertEquals(150_000L, storage.calls.single().second)
        assertContentEquals(a, assertNotNull(again.file("A")).readBytes())
    }

    @Test
    fun `a file the player cannot play is dropped only when really damaged`() {
        val a = bytes(2_000, 21)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a)))
        s.fetchMissing(FakeStorage(mapOf("A" to a)), t0, 0)
        // Intact (the box just cannot play it): kept, counted, never downloaded again in a loop.
        assertTrue(!s.damaged("A"))
        assertNotNull(s.file("A"))
        assertEquals(1L, s.unplayable)
        assertEquals(0L, s.badFiles)
        // Really damaged: dropped and downloaded again.
        assertNotNull(s.file("A")).writeBytes(bytes(2_000, 77))
        assertTrue(s.damaged("A"))
        assertNull(s.file("A"))
        assertEquals(1L, s.badFiles)
        assertEquals(1, s.fetchMissing(FakeStorage(mapOf("A" to a)), t0, 0))
        assertNotNull(s.file("A"))
    }

    @Test
    fun `ended entries with no file are forgotten`() {
        val a = bytes(2_000, 22)
        val s = store()
        s.want(t0 * 1000, listOf(ad("A", a, keepUntil = t0 + 10)))
        val storage = FakeStorage(mapOf("A" to a))
        s.fetchMissing(storage, t0 + 20, 0)
        assertTrue(storage.calls.isEmpty(), "no download for a booking already over")
        assertTrue(store().missing(null).isEmpty())
    }
}
