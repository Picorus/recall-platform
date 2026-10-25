package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlin.random.Random
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OutboxTest {
    private val dir: File = Files.createTempDirectory("outbox").toFile()
    private val day = 24 * 3_600L
    private val t0 = 1_790_000_000L
    private fun report(n: Int) = JsonObject(mapOf("kind" to JsonPrimitive("live"), "n" to JsonPrimitive(n)))
    private fun open(rules: OutboxRules = OutboxRules(segmentReports = 10)) = Outbox(dir, rules)
    private fun seqs(q: List<Queued>) = q.map { it.seq }

    @Test
    fun `reports wait until confirmed, in order, numbered from 1`() {
        val box = open()
        val sent = (1..25).map { box.add(report(it), t0 + it) }
        assertEquals((1L..25L).toList(), seqs(sent))
        assertEquals(sent.take(7), box.nextBatch(7))
        assertEquals(1L, box.oldestHeld())
        box.acknowledge(12)
        assertEquals((13L..25L).toList(), seqs(box.nextBatch(100)))
        assertEquals(13L, box.oldestHeld())
        assertEquals(13, box.waiting())
        // A forged or wrong ack beyond what the box holds, or going back, changes nothing.
        box.acknowledge(99)
        box.acknowledge(3)
        assertEquals(13, box.waiting())
        // The first segment (1–10) is all confirmed, so its file is gone.
        assertEquals(listOf("seg-0000000000000000011", "seg-0000000000000000021"), segs())
        box.acknowledge(25)
        assertEquals(26L, box.oldestHeld())
        assertEquals(emptyList(), box.nextBatch())
    }

    @Test
    fun `an upload holds at most 500 reports`() {
        val box = open(OutboxRules())
        (1..600).forEach { box.add(report(it), t0) }
        assertEquals(500, box.nextBatch(10_000).size)
    }

    @Test
    fun `a restart keeps what waits, leaves no gap, and never reuses a number`() {
        val box = open()
        (1..8).forEach { box.add(report(it), t0) }
        box.acknowledge(3)
        val again = open()
        assertEquals((4L..8L).toList(), seqs(again.nextBatch()))
        assertEquals(9L, again.add(report(9), t0).seq)
        assertEquals(4L, again.oldestHeld())
        // Everything confirmed and deleted: the confirmed number still carries on after a restart.
        again.acknowledge(9)
        assertEquals(0, open().waiting())
        assertEquals(10L, open().add(report(10), t0).seq)
        assertEquals(10L, open().oldestHeld())
    }

    @Test
    fun `numbers given up for space are never used again, even when nothing else is left`() {
        val box = Outbox(dir, OutboxRules(maxBytes = 1, segmentReports = 1))
        (1..5).forEach { box.add(report(it), t0) }
        // Only the newest segment is kept; 1–4 were given up and their top number recorded.
        assertEquals(4L, box.expired)
        assertEquals(listOf(5L), seqs(box.nextBatch()))
        File(dir, segs().single()).delete() // the last one lost too (say, damaged)
        assertEquals(5L, Outbox(dir).add(report(6), t0).seq)
        assertEquals(5L, Outbox(dir).oldestHeld())
    }

    @Test
    fun `a failed write leaves no trace and costs no number`() {
        val box = open(OutboxRules(segmentReports = 1))
        box.add(report(1), t0)
        // The next segment's file cannot be made (something in the way).
        val blocker = File(dir, "seg-%019d".format(2))
        blocker.mkdir()
        File(blocker, "x").writeText("x")
        assertTrue(runCatching { box.add(report(2), t0) }.isFailure)
        File(blocker, "x").delete()
        blocker.delete()
        assertEquals(2L, box.add(report(2), t0).seq)
        assertEquals(listOf(1L, 2L), seqs(open().nextBatch()))
    }

    @Test
    fun `a report needs a time and must be small`() {
        val box = open()
        assertTrue(runCatching { box.add(report(1), -1) }.isFailure)
        val big = JsonObject(mapOf("kind" to JsonPrimitive("x".repeat(Outbox.MAX_REPORT_BYTES))))
        assertTrue(runCatching { box.add(big, t0) }.isFailure)
        assertEquals(1L, box.add(report(1), t0).seq)
    }

    @Test
    fun `an upload stays under the cloud's 256 KB limit`() {
        val box = open(OutboxRules())
        val pad = "p".repeat(2_000)
        (1..300).forEach { box.add(JsonObject(mapOf("kind" to JsonPrimitive("live"), "pad" to JsonPrimitive(pad))), t0) }
        val batch = box.nextBatch()
        val text = ScreenLink.uploadText(batch.map { it.text }, box.oldestHeld())
        assertTrue(batch.size in 100..130, "${batch.size}")
        assertTrue(text.toByteArray().size <= ScreenLink.MAX_UP_BYTES)
    }

    @Test
    fun `a line cut off by a power cut is skipped and later reports are kept`() {
        val box = open()
        (1..3).forEach { box.add(report(it), t0) }
        val seg = File(dir, segs().single())
        seg.appendText("deadbeef\t{\"seq\":4,\"at\":17900")
        val again = open()
        assertEquals(listOf(1L, 2L, 3L), seqs(again.nextBatch()))
        val next = again.add(report(5), t0)
        assertEquals(listOf(1L, 2L, 3L, next.seq), seqs(open().nextBatch()))
        // A damaged line (one character changed) is also skipped, never sent wrong.
        seg.writeText(seg.readText().replaceFirst("\"n\":2", "\"n\":7"))
        assertEquals(listOf(1L, 3L, next.seq), seqs(open().nextBatch()))
    }

    @Test
    fun `after 7 days (by a time the cloud backs), or beyond the space limit, the oldest are given up`() {
        val box = open()
        (1..10).forEach { box.add(report(it), t0) }
        (11..20).forEach { box.add(report(it), t0 + 2 * day) }
        box.acknowledge(2)
        // A report stamped 9 days on (a faked GPS date) gives up nothing by itself.
        box.add(report(21), t0 + 9 * day)
        assertEquals(0L, box.expired)
        box.trim(t0 + 7 * day - 1)
        assertEquals(0L, box.expired)
        box.trim(t0 + 7 * day)
        assertEquals(8L, box.expired)
        assertEquals((11L..21L).toList(), seqs(box.nextBatch()))
        // The cloud is told: the oldest number held is now 11, so it stops waiting for 3–10.
        assertEquals(11L, box.oldestHeld())
        val small = Outbox(File(dir, "small"), OutboxRules(maxBytes = 2_000, segmentReports = 10))
        (1..40).forEach { small.add(report(it), t0) }
        assertTrue(small.expired > 0 && small.bytes() <= 2_000)
        assertEquals(40 - small.expired.toInt(), small.waiting())
        assertEquals(small.oldestHeld(), small.nextBatch().first().seq)
        assertEquals(40L, small.nextBatch().last().seq)
    }

    @Test
    fun `a line damaged after it was written is not claimed as held`() {
        val box = open()
        (1..3).forEach { box.add(report(it), t0) }
        val seg = File(dir, segs().single())
        seg.writeText(seg.readText().replaceFirst("\"n\":1", "\"n\":9"))
        assertEquals(2L, box.oldestHeld())
        assertEquals(listOf(2L, 3L), seqs(box.nextBatch()))
    }

    @Test
    fun `random adds, acks and restarts never lose or repeat a report, and what is held is one run`() {
        val rnd = Random(7)
        var box = open()
        val expected = sortedSetOf<Long>()
        val used = mutableSetOf<Long>()
        repeat(3_000) {
            when (rnd.nextInt(10)) {
                in 0..5 -> box.add(report(it), t0).seq.also { s ->
                    assertTrue(used.add(s), "number $s used twice")
                    expected += s
                }
                in 6..7 -> {
                    val batch = box.nextBatch(rnd.nextInt(1, 30))
                    if (batch.isNotEmpty()) {
                        val upTo = batch[rnd.nextInt(batch.size)].seq
                        box.acknowledge(upTo)
                        expected.removeIf { s -> s <= upTo }
                    }
                }
                8 -> box = open()
                else -> {
                    val held = seqs(box.nextBatch(Int.MAX_VALUE))
                    assertEquals(expected.toList().take(500), held)
                    assertEquals(expected.firstOrNull() ?: box.oldestHeld(), box.oldestHeld())
                }
            }
        }
        assertEquals(expected.size, open().waiting())
    }

    private fun segs() = dir.list()!!.filter { it.startsWith("seg-") }.sorted()
}
