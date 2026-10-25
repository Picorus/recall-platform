// P2.4: the box's ad files (plan: "downloads ads ahead, checks each file's fingerprint, keeps them
// until the booking ends, clears old files when space runs low. Never streams"). The cloud says
// which files to keep (AdFiles, down/files: the whole list each time); this store downloads each one
// ahead over HTTPS, checks its SHA-256 before it may ever be played, and keeps it until its booking
// ends. Ended files, and files no longer listed, stay (a renewed booking needs no new download) until
// space runs low; then files no longer listed go first, then those that ended longest ago. A file
// still needed is never cleared: when there is no room, the new download waits and the box says so
// (health, P2.11). "Ended" is judged only by a time the cloud backs, or the last such time this box
// saw (it is at least that late), never by GPS alone or the box's own settable clock.
//
// On disk, in one folder:
//   wanted          the cloud's last list: its time, then ad, fingerprint, size, keep-until, link
//   seen            the latest time the cloud backed (UTC s): "now is at least this", across restarts
//   files/<sha256>  a whole file whose fingerprint matched; named by it, so two ads with the same
//                   file share it
//   files/<sha256>.part  a download not finished yet (carried on from where it stopped)
// A file is renamed into place only once it is whole and checked, so a power cut never leaves a
// half file that looks finished.
package app.recall.player.core

import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicLong

data class AdStoreRules(
    /** Most space ad files may take. */
    val maxBytes: Long = 4L * 1024 * 1024 * 1024,
    /** Space always left free on the box (the outbox, logs and the system need it). */
    val keepFreeBytes: Long = 512L * 1024 * 1024,
    /** A failed download waits this long, doubling with each failure up to `lastRetryMs`. */
    val firstRetryMs: Long = 60_000,
    val lastRetryMs: Long = 60 * 60_000,
) {
    init {
        require(maxBytes > 0 && keepFreeBytes >= 0 && firstRetryMs > 0 && lastRetryMs >= firstRetryMs)
    }
}

/** A download's bytes: `startsAt` is where they begin in the file (0 when a resume was refused). */
class Fetched(val startsAt: Long, val body: InputStream) : Closeable {
    override fun close() = body.close()
}

/** Opens a download from byte `from` on (the real one: HttpsFetcher). */
fun interface Fetcher {
    fun fetch(url: String, from: Long): Fetched
}

/** A file that came down but is not the one asked for (wrong size or fingerprint). */
class BadFile(message: String) : IOException(message)

class AdStore(
    private val dir: File,
    private val rules: AdStoreRules = AdStoreRules(),
    /** Free space on the box's storage, bytes. */
    private val freeBytes: () -> Long = { dir.usableSpace },
    private val log: (String) -> Unit = {},
) {
    private val files = File(dir, "files")
    private val wanted = LinkedHashMap<String, AdFile>()
    /** When the list in `wanted` was made (the cloud's ms): an older list is ignored. */
    private var made = 0L
    /** Fingerprints of the whole files on disk, checked since the store opened. */
    private val have = HashSet<String>()
    /** Whole files found at start, not checked again yet (checkAll): never played until they are. */
    private val unchecked = HashSet<String>()
    /** The latest time the cloud backed, UTC s (0: none yet). */
    private var seen = 0L
    private class Retry(val failures: Int, val notBefore: Long)
    private val retries = HashMap<String, Retry>()
    /** One download run at a time (the downloader's thread, or a test). */
    private val fetching = Any()

    private val bad = AtomicLong()
    private val roomless = AtomicLong()
    private val clearedCount = AtomicLong()
    /** Downloads that came down wrong (size or fingerprint) or files found damaged. Should stay 0. */
    val badFiles: Long get() = bad.get()
    /** Times a needed file could not be downloaded for lack of space (health alarm, P2.11). */
    val noRoom: Long get() = roomless.get()
    /** Files no longer needed, cleared to make room. */
    val cleared: Long get() = clearedCount.get()

    init {
        files.mkdirs()
        load()
    }

    private fun load() {
        seen = File(dir, "seen").takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull() ?: 0
        File(dir, "wanted").takeIf { it.exists() }?.readLines()?.forEach { line ->
            val p = line.split('\t')
            if (p.size == 2 && p[0] == "made") made = p[1].toLongOrNull() ?: 0
            if (p.size == 5) {
                val f = AdFile(p[0], p[1], p[2].toLongOrNull() ?: 0, p[4], p[3].toLongOrNull() ?: 0)
                if (f.bytes > 0 && AdFiles.SHA256.matches(f.sha256)) wanted[f.ad] = f
            }
        }
        val sizes = wanted.values.associate { it.sha256 to it.bytes }
        for (f in files.listFiles().orEmpty()) {
            val name = f.name
            when {
                AdFiles.SHA256.matches(name) ->
                    // Contents are checked again by checkAll(); a wrong size is plainly not the file.
                    if (sizes[name]?.let { it != f.length() } == true) f.delete() else unchecked += name
                name.endsWith(".part") && name.removeSuffix(".part") in sizes -> {} // carried on later
                else -> f.delete() // a leftover .tmp, or a part nobody wants any more
            }
        }
    }

    /**
     * The cloud's whole list, made at `madeMs` (on storage before this returns). It replaces the one
     * before: an ad left off is no longer needed (its file stays until space runs low), and a booking
     * cut short frees its file sooner. A list older than the last one taken is ignored (lists can
     * arrive out of order across reconnects). Returns false when ignored.
     */
    @Synchronized
    fun want(madeMs: Long, list: List<AdFile>): Boolean {
        if (madeMs < made) return false
        val old = wanted.values.associateBy { it.sha256 }
        wanted.clear()
        for (f in list) {
            wanted[f.ad] = f
            // A fresh link (storage links expire): try it now rather than after the wait.
            if (old[f.sha256]?.url != f.url) retries.remove(f.sha256)
        }
        made = madeMs
        save()
        // A half download nobody wants any more is of no use.
        files.listFiles().orEmpty().filter { it.name.endsWith(".part") && !listed(it.name.removeSuffix(".part")) }.forEach { it.delete() }
        return true
    }

    private fun listed(sha: String) = wanted.values.any { it.sha256 == sha }

    /** The checked file to play for this ad, or null while it is not here (never streamed). */
    @Synchronized
    fun file(ad: String): File? {
        val w = wanted[ad] ?: return null
        if (w.sha256 !in have) return null
        return File(files, w.sha256).takeIf { it.length() == w.bytes }
    }

    /** The player found this ad's file unplayable: drop it, so it is downloaded again. */
    @Synchronized
    fun damaged(ad: String) {
        val sha = wanted[ad]?.sha256 ?: return
        if (have.remove(sha)) {
            File(files, sha).delete()
            bad.incrementAndGet()
            log("ads: the file for $ad was damaged; downloading it again")
        }
    }

    /**
     * Files still needed and not here yet, the soonest-ending first (most likely playing now).
     * `nowSeconds`: a time the cloud backs, if known; else the last one seen.
     */
    @Synchronized
    fun missing(nowSeconds: Long?): List<AdFile> = wanted.values
        .filter { it.sha256 !in have && it.sha256 !in unchecked && notEnded(it, now(nowSeconds)) }
        .distinctBy { it.sha256 }
        .sortedBy { it.keepUntil }

    /** Bytes the ad files take now. */
    @Synchronized
    fun bytes(): Long = files.listFiles().orEmpty().sumOf { it.length() }

    /**
     * Downloads what is missing, one file after another. `nowSeconds`: a time the cloud backs, or
     * null: then nothing counts as ended (a faked GPS date must not clear needed files). `monoMs`:
     * the box's counter, for the waits after a failure. Returns how many files came down whole.
     */
    fun fetchMissing(fetcher: Fetcher, nowSeconds: Long?, monoMs: Long): Int = synchronized(fetching) {
        remember(nowSeconds)
        val now = synchronized(this) { now(nowSeconds) }
        forgetEnded(now)
        var done = 0
        for (f in missing(now)) {
            if (Thread.currentThread().isInterrupted) break
            if ((synchronized(this) { retries[f.sha256] }?.notBefore ?: Long.MIN_VALUE) > monoMs) continue
            val part = File(files, "${f.sha256}.part")
            if (!makeRoom(f.bytes - minOf(part.length(), f.bytes), now, f.sha256)) {
                roomless.incrementAndGet()
                log("ads: no room for ${f.ad} (${f.bytes / 1_000_000} MB); waiting")
                continue
            }
            val before = part.length()
            try {
                download(fetcher, f, part)
                synchronized(this) {
                    DiskFiles.moveAtomically(part, File(files, f.sha256))
                    have += f.sha256
                    retries.remove(f.sha256)
                }
                done++
            } catch (e: Exception) {
                if (e is BadFile) {
                    part.delete()
                    bad.incrementAndGet()
                } else if (part.length() > before) {
                    // Cut short but it got further: a weak 4G link, not a bad file. Carry on at the
                    // next run, without the growing wait (review, P2.4).
                    synchronized(this) { retries.remove(f.sha256) }
                    log("ads: ${f.ad} at ${part.length()} of ${f.bytes} bytes; carrying on")
                    continue
                }
                val failures = (synchronized(this) { retries[f.sha256] }?.failures ?: 0) + 1
                val wait = minOf(rules.firstRetryMs shl minOf(failures - 1, 20), rules.lastRetryMs)
                synchronized(this) { retries[f.sha256] = Retry(failures, monoMs + wait) }
                log("ads: ${f.ad} not downloaded (${e.javaClass.simpleName}: ${e.message}); next try in ${wait / 1000} s")
            }
        }
        done
    }

    /** Downloads into `part`, carrying on from what is there, then checks size and fingerprint. */
    private fun download(fetcher: Fetcher, f: AdFile, part: File) {
        if (part.length() > f.bytes) part.delete()
        val from = part.length()
        if (from < f.bytes) {
            fetcher.fetch(f.url, from).use { got ->
                if (got.startsAt != from && got.startsAt != 0L) throw IOException("the server sent the wrong part")
                var at = got.startsAt
                FileOutputStream(part, at > 0).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var unsynced = 0L
                    try {
                        while (true) {
                            if (Thread.currentThread().isInterrupted) throw IOException("stopped")
                            val n = got.body.read(buf)
                            if (n < 0) break
                            at += n
                            if (at > f.bytes) throw BadFile("bigger than ${f.bytes} bytes")
                            out.write(buf, 0, n)
                            // Kept every few MB, so a power cut loses little of a slow download.
                            unsynced += n
                            if (unsynced >= SYNC_EVERY) {
                                out.fd.sync()
                                unsynced = 0
                            }
                        }
                    } finally {
                        runCatching { out.fd.sync() }
                    }
                }
            }
        }
        // Cut short (the line dropped): kept, and carried on next time.
        if (part.length() != f.bytes) throw IOException("cut short at ${part.length()} of ${f.bytes} bytes")
        if (sha256(part) != f.sha256) throw BadFile("the fingerprint does not match")
    }

    /**
     * Clears files until `need` more bytes fit: first files no ad on the list uses, then files whose
     * bookings ended longest ago. Never a file still needed, nor the one being downloaded. Returns
     * false when that is not enough. `nowSeconds`: as `now()` gives (null: nothing has ended).
     */
    @Synchronized
    private fun makeRoom(need: Long, nowSeconds: Long?, forSha: String): Boolean {
        fun fits() = bytes() + need <= rules.maxBytes && freeBytes() - need >= rules.keepFreeBytes
        while (!fits()) {
            val victim = files.listFiles().orEmpty()
                .map { it to it.name.removeSuffix(".part") }
                .filter { (_, sha) -> sha != forSha && !needed(sha, nowSeconds) }
                .minByOrNull { (_, sha) -> wanted.values.filter { it.sha256 == sha }.maxOfOrNull { it.keepUntil } ?: Long.MIN_VALUE }
                ?: return false
            victim.first.delete()
            have -= victim.second
            unchecked -= victim.second
            if (!victim.first.name.endsWith(".part")) clearedCount.incrementAndGet()
            // Its ended entries go too: nothing is left to keep for them.
            if (wanted.values.removeAll { it.sha256 == victim.second }) save()
        }
        return true
    }

    /** Some ad on the list still runs on this file (with no time known, every listed one does). */
    private fun needed(sha: String, nowSeconds: Long?) = wanted.values.any { it.sha256 == sha && notEnded(it, nowSeconds) }

    private fun notEnded(f: AdFile, nowSeconds: Long?) = nowSeconds == null || f.keepUntil > nowSeconds

    /** The time to judge "ended" by: the cloud-backed time, else the last one seen, else none. */
    private fun now(nowSeconds: Long?): Long? = maxOf(nowSeconds ?: 0, seen).takeIf { it > 0 }

    /** Keeps the latest cloud-backed time on storage (written at most once a minute). */
    @Synchronized
    private fun remember(nowSeconds: Long?) {
        if (nowSeconds == null || nowSeconds < seen + 60) return
        seen = nowSeconds
        runCatching { DiskFiles.writeAtomically(File(dir, "seen"), nowSeconds.toString()) }
    }

    /** Ended entries whose file is not here are forgotten (nothing to download, nothing to keep). */
    @Synchronized
    private fun forgetEnded(nowSeconds: Long?) {
        if (nowSeconds == null) return
        val gone = wanted.values.removeAll { !notEnded(it, nowSeconds) && it.sha256 !in have && it.sha256 !in unchecked }
        if (gone) {
            files.listFiles().orEmpty().filter { it.name.endsWith(".part") && !listed(it.name.removeSuffix(".part")) }.forEach { it.delete() }
            save()
        }
    }

    /**
     * Checks the fingerprint of every file found at start (storage can be damaged while the box is
     * off), the soonest-ending listed files first; none is played until checked. A damaged one is
     * deleted and downloaded again. Returns how many were damaged.
     */
    fun checkAll(): Int {
        var damaged = 0
        val order = synchronized(this) {
            unchecked.sortedBy { sha -> wanted.values.filter { it.sha256 == sha }.minOfOrNull { it.keepUntil } ?: Long.MAX_VALUE }
        }
        for (sha in order) {
            if (Thread.currentThread().isInterrupted) break
            val ok = runCatching { sha256(File(files, sha)) == sha }.getOrDefault(false)
            synchronized(this) {
                if (!unchecked.remove(sha)) return@synchronized
                if (ok) {
                    have += sha
                } else {
                    File(files, sha).delete()
                    bad.incrementAndGet()
                    damaged++
                    log("ads: file $sha was damaged; downloading it again")
                }
            }
        }
        return damaged
    }

    private fun save() = DiskFiles.writeAtomically(
        File(dir, "wanted"),
        "made\t$made\n" + wanted.values.joinToString("") { "${it.ad}\t${it.sha256}\t${it.bytes}\t${it.keepUntil}\t${it.url}\n" },
    )

    private companion object {
        /** Bytes written between syncs during a download. */
        const val SYNC_EVERY = 4L * 1024 * 1024

        fun sha256(f: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            FileInputStream(f).use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
