// P2.3: store-and-forward, the box's side of P1.2.5 (packages/domain/src/screen-reports.ts: enqueue,
// nextBatch, oldestHeld, acknowledge). Every report (plays, minute summaries, live positions) is
// written to the box's own storage before it is sent, numbered 1, 2, 3 … and kept until the cloud says
// it has stored everything up to its number, for at least 7 days (plan: "store-and-forward up to 7
// days"). So no play is lost to a weak 4G link, a dead zone or a power cut, and the cloud stores each
// number once however often it is sent.
//
// On disk, in one folder:
//   seg-<seq>   reports, one per line: a checksum and the report's text. Appended only; a line cut off
//               by a power cut, or damaged, is skipped
//   acked       the highest number the cloud has confirmed
//   floor       the highest number given up unsent (written before those reports are deleted)
// The next number is one more than the highest of: any report on disk, `acked`, `floor`. So a number
// that ever left the box is never used again, and a restart leaves no gap.
// A segment file is deleted once everything in it is confirmed, or when it is too old or space runs
// out (always the oldest first, so the numbers the box holds stay one unbroken run).
package app.recall.player.core

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.zip.CRC32
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

data class OutboxRules(
    /** Reports at least this old are given up (plan: 7 days; KEEP_UNSENT_SECONDS in the cloud). */
    val keepSeconds: Long = 7 * 24 * 3_600L,
    /** Most space the outbox may use; the oldest reports go first beyond it. */
    val maxBytes: Long = 256L * 1024 * 1024,
    /** Reports per segment file. */
    val segmentReports: Int = 500,
) {
    init {
        require(keepSeconds > 0 && maxBytes > 0 && segmentReports > 0)
    }
}

/** A report waiting in the outbox: its number, when it was made (UTC seconds) and its exact text. */
data class Queued(val seq: Long, val at: Long, val text: String)

class Outbox(
    private val dir: File,
    private val rules: OutboxRules = OutboxRules(),
    /**
     * Finishes a report once its number is known, before it is stored: plays are signed here, over
     * their number (PlaySigner, P2.7). Applied again when reports are renumbered.
     */
    private val seal: (Long, JsonObject) -> JsonObject = { _, r -> r },
) {
    private class Entry(val seq: Long, val at: Long)
    private class Segment(val file: File, val entries: MutableList<Entry> = mutableListOf(), var bytes: Long = 0)

    private val segments = mutableListOf<Segment>()
    private var next = 1L
    private var acked = 0L
    /** The segment new reports go to; null until the first report after opening. */
    private var open: Segment? = null

    /** Reports given up unsent since the box started (too old, or out of space). Should stay 0. */
    var expired = 0L
        private set

    init {
        dir.mkdirs()
        load()
    }

    /** Reads the state from disk (at start, and after a write failed half-way). */
    private fun load() {
        segments.clear()
        open = null
        var highest = 0L
        dir.listFiles { f -> f.name.startsWith("seg-") && !f.name.endsWith(".tmp") }.orEmpty().sortedBy { it.name }.forEach { f ->
            val seg = Segment(f, bytes = f.length())
            f.forEachLine { line ->
                parse(line)?.let {
                    seg.entries += Entry(it.seq, it.at)
                    highest = maxOf(highest, it.seq)
                }
            }
            segments += seg
        }
        acked = readNumber("acked")
        next = maxOf(highest, acked, readNumber("floor")) + 1
        dropConfirmed()
    }

    /**
     * Puts a report in the outbox (on storage before this returns) and gives it its number. `at`:
     * when it was made, UTC seconds, from the trusted clock. Beyond the space limit the oldest go.
     */
    @Synchronized
    fun add(report: JsonObject, at: Long): Queued {
        require(at >= 0) { "a report needs its time" }
        val seq = next
        val text = ScreenLink.numberedText(seq, at, seal(seq, report))
        val line = "${crc(text)}\t$text\n"
        val size = line.toByteArray().size
        require(size <= MAX_REPORT_BYTES) { "a report must be under ${MAX_REPORT_BYTES / 1024} KB" }
        val current = open?.takeIf { it.entries.size < rules.segmentReports }
        val seg = current ?: Segment(File(dir, "seg-%019d".format(seq)))
        val before = seg.file.length()
        try {
            appendSynced(seg.file, line)
            if (current == null) DiskFiles.syncDir(dir)
        } catch (e: Exception) {
            undoAppend(seg.file, before, current == null)
            throw e
        }
        if (current == null) {
            segments += seg
            open = seg
        }
        next = seq + 1
        seg.entries += Entry(seq, at)
        seg.bytes += size
        // The report is safe on disk now; a failure making room is retried with the next report.
        runCatching { while (segments.size > 1 && bytes() > rules.maxBytes) dropFirst() }
        return Queued(seq, at, text)
    }

    /**
     * A write failed part-way: cut the file back so no half line (or an unrecorded whole one) stays.
     * If even that fails, the state is read again from disk, so memory and disk agree.
     */
    private fun undoAppend(file: File, length: Long, fresh: Boolean) {
        try {
            if (fresh) {
                file.delete()
            } else {
                RandomAccessFile(file, "rw").use {
                    it.setLength(length)
                    it.fd.sync()
                }
            }
        } catch (_: Exception) {
            load()
        }
        // Never append after a failure: the next report starts a new segment.
        open = null
    }

    /**
     * The oldest reports not yet confirmed, in order: at most `limit`, at most 500, and small enough
     * for one upload (the cloud refuses anything over 256 KB).
     */
    @Synchronized
    fun nextBatch(limit: Int = ScreenLink.MAX_BATCH): List<Queued> {
        val max = minOf(limit, ScreenLink.MAX_BATCH)
        val out = mutableListOf<Queued>()
        var size = UPLOAD_HEADER_BYTES
        for (q in unconfirmed()) {
            val more = q.text.toByteArray().size + 1
            if (out.size >= max || size + more > ScreenLink.MAX_UP_BYTES) break
            out += q
            size += more
        }
        return out
    }

    /**
     * The smallest number the box still holds; sent with every upload (the cloud's `receive`). Read
     * the same way as `nextBatch`, so a line damaged since it was written is not claimed as held.
     */
    @Synchronized
    fun oldestHeld(): Long = unconfirmed().firstOrNull()?.seq ?: next

    /** Unconfirmed reports as they read from disk now, oldest first. */
    private fun unconfirmed(): Sequence<Queued> = segments.toList().asSequence()
        .filter { s -> s.entries.isNotEmpty() && s.entries.last().seq > acked }
        .flatMap { s -> s.file.useLines { lines -> lines.mapNotNull(::parse).filter { it.seq > acked }.toList() } }

    /**
     * The cloud has stored everything up to and including `seq`: forget it. An ack beyond the
     * highest number held is not applied here (see `renumberAfter`), so it can never empty the
     * outbox. Returns true when it moved the outbox on.
     */
    @Synchronized
    fun acknowledge(seq: Long): Boolean {
        val highest = segments.lastOrNull { it.entries.isNotEmpty() }?.entries?.last()?.seq ?: return false
        if (seq <= acked || seq > highest) return false
        DiskFiles.writeAtomically(File(dir, "acked"), seq.toString())
        acked = seq
        dropConfirmed()
        return true
    }

    /** The highest number this box has handed out (0 before the first report). */
    @Synchronized
    fun lastNumber(): Long = next - 1

    /**
     * The cloud says it has every number up to `cloudUpTo`, beyond any this box ever handed out: the
     * box's numbering started again (its outbox was lost while its keys survived). The cloud would
     * take the reports still waiting as repeats and drop them, so they are numbered again after
     * `cloudUpTo` (review, P2.3.3); plays are signed again for their new numbers (`seal`). Safe across a power cut: the new numbers are recorded first, the
     * copies written, then the old lines deleted (an old line left behind is taken as a repeat).
     * Returns how many reports were renumbered.
     */
    @Synchronized
    fun renumberAfter(cloudUpTo: Long): Int {
        if (cloudUpTo <= next - 1) return 0
        val waiting = unconfirmed().toList()
        DiskFiles.writeAtomically(File(dir, "floor"), cloudUpTo.toString())
        next = cloudUpTo + 1
        val old = segments.toList()
        open = null
        for (q in waiting) {
            val body = q.text.substring(HEAD.find(q.text)!!.range.last + 1, q.text.length - 1)
            add(Json.parseToJsonElement(body).jsonObject, q.at)
        }
        old.forEach(::delete)
        return waiting.size
    }

    /** Reports waiting for the cloud, and the space the outbox takes. */
    @Synchronized
    fun waiting(): Int = segments.sumOf { s -> s.entries.count { it.seq > acked } }

    @Synchronized
    fun bytes(): Long = segments.sumOf { it.bytes }

    /**
     * Gives up reports at least 7 days old, oldest segment first; counted in `expired`. Call it with
     * a time the cloud backs (`TrustedClock` with a cloud reading), never GPS alone: a faked GPS date
     * a week ahead must not wipe the outbox. Until then reports are kept (space limit aside).
     */
    @Synchronized
    fun trim(nowSeconds: Long) {
        while (segments.isNotEmpty() && nowSeconds - segments.first().entries.maxOf { it.at } >= rules.keepSeconds)
            dropFirst()
    }

    private fun dropFirst() {
        val seg = segments.first()
        val top = seg.entries.last().seq
        // Recorded before the reports go, so their numbers are never used again.
        if (top > acked && top > readNumber("floor")) DiskFiles.writeAtomically(File(dir, "floor"), top.toString())
        expired += seg.entries.count { it.seq > acked }
        delete(seg)
    }

    private fun dropConfirmed() {
        segments.filter { s -> s.entries.isEmpty() || (s.entries.last().seq <= acked && s !== open) }.forEach(::delete)
    }

    private fun delete(seg: Segment) {
        seg.file.delete()
        segments.remove(seg)
        if (open === seg) open = null
    }

    private fun readNumber(name: String): Long =
        File(dir, name).takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull() ?: 0

    /** A stored line back as a report, or null when it is cut off or damaged. */
    private fun parse(line: String): Queued? {
        val tab = line.indexOf('\t')
        if (tab < 0) return null
        val text = line.substring(tab + 1)
        if (line.substring(0, tab) != crc(text)) return null
        val m = HEAD.find(text) ?: return null
        return Queued(m.groupValues[1].toLong(), m.groupValues[2].toLong(), text)
    }

    companion object {
        /** Largest single report (a play with its signature is well under 1 KB). */
        const val MAX_REPORT_BYTES = 16 * 1024
        /** Room for `{"v":1,"oldestHeld":…,"batch":[` and `]}`. */
        private const val UPLOAD_HEADER_BYTES = 64

        private val HEAD = Regex("^\\{\"seq\":(\\d{1,18}),\"at\":(\\d{1,18}),\"report\":")

        private fun crc(s: String): String = CRC32().apply { update(s.toByteArray()) }.value.toString(16)

        private fun appendSynced(f: File, text: String) = FileOutputStream(f, true).use {
            it.write(text.toByteArray())
            it.fd.sync()
        }
    }
}
