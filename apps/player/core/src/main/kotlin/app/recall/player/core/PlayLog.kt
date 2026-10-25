// P2.7: the signed play log. Every spot the screen counts (Conductor: timed, whole, confirmed on
// screen, an ad, never counted before) becomes a play record, signed with the box's own play key
// (made at enrolment inside the Android Keystore, P2.1; the cloud knows it as "k1") and put in the
// outbox (P2.3), which keeps it on storage until the cloud confirms it (7 days at most). The cloud
// checks the signature over exactly the bytes the box signed (packages/domain/src/plays.ts
// playBytes; shared cases in test-vectors/plays.json) and never counts a play the box did not sign.
//
// The signed bytes hold the report's number in the outbox, so the play is signed as it is numbered
// (Outbox `seal`); a report renumbered later (the box's numbering started again) is signed again.
// Spots that do not count (part-way, not confirmed, the slate, no trusted time) are never recorded:
// they go to the health counters (P2.11). People counted (P2.9) are an estimate, never billed: 0 until
// the people counter is built.
//
// Signing and storing take a moment (the keystore, a write to storage), so they happen on the play
// log's own thread: the next spot is never held up. The latest spot counted is kept on storage
// before its record is stored, so a box that restarts (or whose clock goes back) never counts a spot
// twice; a power cut in between loses that one play, never adds one.
package app.recall.player.core

import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Where the bike was for a play: position in millionths of a degree, its accuracy, and the area. */
data class Where(val latE6: Long, val lngE6: Long, val accuracyM: Long, val place: String) {
    companion object {
        /** No GPS fix: no position the cloud could use (it keeps the play but does not count it). */
        const val NO_FIX_ACCURACY_M = 100_000L

        fun unknown(place: String = "outside") = Where(0, 0, NO_FIX_ACCURACY_M, place)

        fun of(position: LatLng?, accuracyM: Double?, place: Place): Where =
            if (position == null || accuracyM == null || !accuracyM.isFinite()) {
                unknown(place.key)
            } else {
                Where(
                    Math.round(position.lat * 1e6),
                    Math.round(position.lng * 1e6),
                    // Rounded up: never claim a fix better than it was.
                    kotlin.math.ceil(accuracyM).toLong().coerceIn(0, NO_FIX_ACCURACY_M),
                    place.key,
                )
            }
    }
}

/** Where the bike was at a second (UTC); null when not known. */
fun interface WhereSource {
    fun where(utcSecond: Long): Where?
}

/** A play record and the exact bytes signed for it: the same as the cloud's playBytes. */
object PlayRecord {
    /** The play key's name in the cloud (FIRST_PLAY_KEY), kept under Enrolment.PLAY_KEY on the box. */
    const val FIRST_KEY_ID = "k1"
    private const val HEADER = "RECALL-PLAY-1"
    /** The signed fields, in the signed order (after the header, screen id and number). */
    private val FIELDS = listOf("keyId", "slot", "ref", "adId", "startAt", "lengthS", "latE6", "lngE6", "accuracyM", "place", "people")
    private val SLOTS = setOf("brand", "make-up", "aggregator", "recall")
    /** Printable ASCII, as the cloud reads text fields (no line breaks: one field per line). */
    private val TEXT = Regex("[\\x20-\\x7e]{0,120}")

    fun report(
        slot: String,
        ref: String,
        adId: String,
        startAt: Long,
        lengthS: Long,
        where: Where,
        people: Long = 0,
        keyId: String = FIRST_KEY_ID,
    ): JsonObject {
        // What the cloud would refuse is never signed (checkPlayShape).
        require(slot in SLOTS) { "bad slot $slot" }
        require(TEXT.matches(ref) && (ref.isNotEmpty() || slot == "recall")) { "bad reference" }
        require(TEXT.matches(adId) && adId.isNotEmpty()) { "bad ad id" }
        require(TEXT.matches(where.place) && where.place.isNotEmpty()) { "bad place" }
        require(TEXT.matches(keyId) && keyId.isNotEmpty()) { "bad key id" }
        require(startAt in 0..(1L shl 32) && lengthS in 1..60) { "bad time" }
        require(where.latE6 in -90_000_000..90_000_000 && where.lngE6 in -180_000_000..180_000_000) { "bad position" }
        require(where.accuracyM in 0..Where.NO_FIX_ACCURACY_M && people in 0..100_000) { "bad numbers" }
        return buildJsonObject {
            put("kind", "play")
            put("keyId", keyId)
            put("slot", slot)
            put("ref", ref)
            put("adId", adId)
            put("startAt", startAt)
            put("lengthS", lengthS)
            put("latE6", where.latE6)
            put("lngE6", where.lngE6)
            put("accuracyM", where.accuracyM)
            put("place", where.place)
            put("people", people)
        }
    }

    /** The exact bytes signed for a play numbered `seq` (the cloud's playBytes). */
    fun bytes(screenId: String, seq: Long, report: JsonObject): String =
        (listOf(HEADER, screenId, seq.toString()) + FIELDS.map { k ->
            (report[k] as? JsonPrimitive)?.content ?: error("a play needs its $k")
        }).joinToString("\n")
}

/** Signs plays as the outbox numbers them (Outbox `seal`). Other reports pass unchanged. */
class PlaySigner(
    private val screenId: String,
    private val vault: KeyVault,
    private val alias: String = Enrolment.PLAY_KEY,
) {
    fun seal(seq: Long, report: JsonObject): JsonObject {
        if ((report["kind"] as? JsonPrimitive)?.content != "play") return report
        // A report signed before (renumbered): its old signature is for its old number.
        val body = JsonObject(report - "sig")
        val sig = vault.sign(alias, bytes(seq, body).toByteArray(Charsets.UTF_8))
        return JsonObject(body + ("sig" to JsonPrimitive(sig)))
    }

    private fun bytes(seq: Long, body: JsonObject) = PlayRecord.bytes(screenId, seq, body)
}

/** The latest spot counted (UTC ms), kept on storage across restarts (see PlayedMark). */
class MarkFile(private val file: File) {
    fun load(): Long = runCatching { file.readText().trim().toLong() }.getOrDefault(Long.MIN_VALUE)

    fun save(startUtc: Long) {
        file.parentFile?.mkdirs()
        DiskFiles.writeAtomically(file, startUtc.toString())
    }
}

class PlayLog(
    private val outbox: Outbox,
    private val places: WhereSource,
    private val mark: MarkFile,
    /** A record was stored: send it soon (the line's nudge). */
    private val stored: () -> Unit = {},
    private val log: (String) -> Unit = {},
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { Thread(it, "recall-plays").apply { isDaemon = true } },
) {
    private val recordedCount = AtomicLong()
    private val failedCount = AtomicLong()
    /** Plays signed and stored. */
    val recorded: Long get() = recordedCount.get()
    /** Plays counted on screen but not stored (storage or the key failed). Should stay 0; health, P2.11. */
    val failed: Long get() = failedCount.get()

    /** Hands on one spot shown (Conductor `played`, the playback thread): never waits. */
    fun record(p: Played) {
        if (!p.counts) return
        val start = p.spot.startUtc
        val end = p.spot.endUtc
        val shows = p.spot.shows
        if (start == null || end == null || shows == null) return
        val startS = Math.floorDiv(start, 1000L)
        val report = try {
            val w = runCatching { places.where(startS) }.getOrNull() ?: Where.unknown()
            PlayRecord.report(shows.kind, shows.id ?: "", shows.ad, startS, (end - start) / 1000, w)
        } catch (e: Exception) {
            return fail("${shows.ad} at $startS not recorded: ${e.message}")
        }
        try {
            worker.execute {
                try {
                    mark.save(start)
                    outbox.add(report, startS)
                    recordedCount.incrementAndGet()
                    runCatching(stored)
                } catch (e: Exception) {
                    fail("${shows.ad} at $startS not stored: ${e.javaClass.simpleName}: ${e.message}")
                }
            }
        } catch (e: Exception) {
            fail("${shows.ad} at $startS not stored: the play log is closed")
        }
    }

    private fun fail(problem: String) {
        failedCount.incrementAndGet()
        log("plays: $problem")
    }

    /** Waits for the records handed on so far to be stored (tests, and before the app goes away). */
    fun flush(waitMs: Long = 5_000) {
        val done = java.util.concurrent.CountDownLatch(1)
        runCatching { worker.execute { done.countDown() } }
        done.await(waitMs, java.util.concurrent.TimeUnit.MILLISECONDS)
    }
}
