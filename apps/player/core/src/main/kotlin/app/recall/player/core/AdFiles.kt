// P2.4: the list of ad files the cloud wants this screen to keep (down/files). The same rules as
// packages/domain/src/ad-files.ts, checked against the same shared cases (test-vectors/ad-files.json).
package app.recall.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** One ad file to keep: its ad, the SHA-256 of its file, size, an HTTPS link, keep until (UTC s). */
data class AdFile(val ad: String, val sha256: String, val bytes: Long, val url: String, val keepUntil: Long)

/**
 * A list read from the cloud: the whole list, made at `made` (the cloud's UTC ms), or why it is
 * refused whole. A newer list replaces an older one; anything left off is no longer needed.
 */
data class AdFileList(val made: Long, val files: List<AdFile>, val problem: String? = null)

object AdFiles {
    /** Largest ad file (a 15-second video for the screen is a few MB). */
    const val MAX_BYTES = 64L * 1024 * 1024
    const val MAX_FILES = 200
    /** No file is kept longer than this past the list's own time (a wrong date cannot lock storage). */
    const val MAX_KEEP_SECONDS = 400L * 24 * 3600
    private const val MAX_SAFE = (1L shl 53) - 1

    private val AD_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    val SHA256 = Regex("^[0-9a-f]{64}$")
    /** Printable ASCII only (links are percent-encoded), exactly as the cloud checks. */
    private val HTTPS = Regex("^https://[\\x21-\\x7E]+$")
    private val FIELDS = setOf("ad", "sha256", "bytes", "url", "keepUntil")

    fun parse(text: String): AdFileList {
        val x = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject
            ?: return refused("not a JSON object")
        if (x.keys != setOf("v", "made", "files")) return refused("not a file list")
        if (whole(x.getValue("v"), 1, 1) == null) return refused("unknown version")
        val made = whole(x.getValue("made"), 1, MAX_SAFE) ?: return refused("bad list time")
        val list = x.getValue("files") as? JsonArray ?: return refused("bad files")
        if (list.size > MAX_FILES) return refused("bad files")
        val files = mutableListOf<AdFile>()
        for (e in list) {
            val f = entry(e, made)
            files += f.getOrElse { return refused(it.message ?: "bad entry") }
        }
        if (files.map { it.ad }.toSet().size != files.size) return refused("an ad listed twice")
        if (files.groupBy { it.sha256 }.values.any { same -> same.map { it.bytes }.toSet().size > 1 })
            return refused("one file with two sizes")
        return AdFileList(made, files)
    }

    private fun entry(e: JsonElement, made: Long): Result<AdFile> = runCatching {
        val o = e as? JsonObject
        check(o != null && o.keys == FIELDS) { "wrong fields" }
        val ad = text(o.getValue("ad"))
        check(ad != null && AD_ID.matches(ad)) { "bad ad id" }
        val sha = text(o.getValue("sha256"))
        check(sha != null && SHA256.matches(sha)) { "bad fingerprint" }
        val bytes = whole(o.getValue("bytes"), 1, MAX_BYTES)
        check(bytes != null) { "bad size" }
        val url = text(o.getValue("url"))
        check(url != null && url.length <= 2048 && HTTPS.matches(url)) { "not an HTTPS link" }
        val keepUntil = whole(o.getValue("keepUntil"), 1, made / 1000 + MAX_KEEP_SECONDS)
        check(keepUntil != null) { "bad keep-until" }
        AdFile(ad, sha, bytes, url, keepUntil)
    }

    private fun refused(problem: String) = AdFileList(0, emptyList(), problem)

    private fun text(e: JsonElement): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    /**
     * A whole number written as a number (not as text, not 1.5) within the range. Stricter than the
     * cloud's check on "1.0", which the cloud never writes (it writes whole numbers only).
     */
    private fun whole(e: JsonElement, min: Long, max: Long): Long? =
        (e as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it in min..max }
}
