// P2.13: new player versions on the box (the cloud's packages/domain/src/updates.ts; shared cases
// test-vectors/updates.json). The cloud offers a version when this screen is in the rollout's stage,
// or the rollback build when the version it runs was rolled back. The box takes only a version
// numbered above its own (Android refuses lower ones anyway), downloads it over HTTPS on its own
// thread (carrying on where a weak link cut it), checks the size and SHA-256 fingerprint, and has it
// installed (device owner: nobody taps anything). A wrong file or a refused install counts as a
// failed try; after 3 the version is given up until a newer one comes. A weak link never counts: the
// download carries on with the next offer. It never takes the room ads and plays need.
package app.recall.player.core

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

data class UpdateFile(val made: Long, val versionCode: Int, val versionName: String, val sha256: String, val bytes: Long, val url: String)

object UpdateMessages {
    const val MAX_BYTES = 200L * 1024 * 1024
    private val KEYS = setOf("v", "made", "versionCode", "versionName", "sha256", "bytes", "url")
    private val SHA256 = Regex("[0-9a-f]{64}")
    private val NAME = Regex("[0-9A-Za-z.+-]{1,40}")
    private val URL = Regex("https://[\\x21-\\x7e]{1,2000}")
    private const val MAX_SAFE = (1L shl 53) - 1

    private fun whole(e: Any?, min: Long, max: Long = MAX_SAFE): Long? {
        val p = (e as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val n = p.content.toBigDecimalOrNull() ?: return null
        return runCatching { n.longValueExact() }.getOrNull()?.takeIf { it in min..max }
    }

    private fun str(e: Any?) = (e as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The file offered, or why the message is refused (the same reasons as the cloud). */
    fun parse(text: String): Pair<UpdateFile?, String?> {
        val x = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        if (x == null || x.keys != KEYS) return null to "not an update"
        if (whole(x["v"], 1, 1) == null) return null to "unknown version"
        val made = whole(x["made"], 1) ?: return null to "bad time"
        val code = whole(x["versionCode"], 1, 2_100_000_000) ?: return null to "bad version code"
        val name = str(x["versionName"])?.takeIf(NAME::matches) ?: return null to "bad version name"
        val sha = str(x["sha256"])?.takeIf(SHA256::matches) ?: return null to "bad fingerprint"
        val bytes = whole(x["bytes"], 1, MAX_BYTES) ?: return null to "bad size"
        val url = str(x["url"])?.takeIf(URL::matches) ?: return null to "bad link"
        return UpdateFile(made, code.toInt(), name, sha, bytes, url) to null
    }
}

class Updater(
    private val dir: File,
    /** The version code this box runs now. */
    private val ownCode: Int,
    private val fetcher: Fetcher,
    /** Installs a downloaded, checked file (on the box: the package installer as device owner). */
    private val install: (File, UpdateFile) -> Unit,
    private val log: (String) -> Unit = {},
    /** Runs the download (on the box: its own thread). */
    private val run: (Runnable) -> Unit = Executors.newSingleThreadExecutor { Thread(it, "recall-update").apply { isDaemon = true } }::execute,
    /** Free space where updates are kept: an update never takes the room ads and plays need. */
    private val freeBytes: () -> Long = { dir.usableSpace },
) {
    private val queued = HashSet<Int>()
    /** The newest version offered: an older offer still downloading is never installed. */
    private var newest = 0
    private val tries = HashMap<Int, Int>()

    init {
        dir.mkdirs()
        // Leftovers of versions now installed or older are of no more use.
        dir.listFiles()?.forEach { f ->
            val code = f.name.substringAfter("player-").substringBefore(".").toIntOrNull()
            if (code == null || code <= ownCode) f.delete()
        }
    }

    /** An update message from the cloud (the line's thread). True when a download was started. */
    @Synchronized
    fun onUpdate(text: String): Boolean {
        val (file, problem) = UpdateMessages.parse(text)
        if (file == null) {
            log("update refused: $problem")
            return false
        }
        if (file.versionCode <= ownCode) return false // already this or newer
        if (file.versionCode in queued) return false // on its way
        if ((tries[file.versionCode] ?: 0) >= MAX_TRIES) return false // given up until a newer one
        if (file.versionCode > newest) newest = file.versionCode
        queued += file.versionCode
        run(Runnable { fetchAndInstall(file) })
        return true
    }

    private fun fetchAndInstall(f: UpdateFile) {
        val part = File(dir, "player-${f.versionCode}.part")
        val done = File(dir, "player-${f.versionCode}.apk")
        try {
            if (synchronized(this) { f.versionCode != newest }) return // a newer one was offered
            // Files of any other version are of no more use (rolled back, replaced).
            dir.listFiles()?.filter { !it.name.startsWith("player-${f.versionCode}.") }?.forEach { it.delete() }
            if (!done.exists()) {
                val have = if (part.exists()) part.length() else 0L
                if (freeBytes() < f.bytes - have + SPARE_BYTES) {
                    log("update ${f.versionName}: not enough room, waiting")
                    return
                }
                download(f, part)
                check(part.renameTo(done)) { "could not keep the file" }
            }
            checkFile(f, done)
            if (synchronized(this) { f.versionCode != newest }) return
            log("update ${f.versionName}: installing")
            install(done, f)
        } catch (e: BadFile) {
            part.delete()
            done.delete()
            failed(f, done, e)
        } catch (e: java.io.IOException) {
            // A weak link, a server hiccup: not counted; carried on from where it stopped next time.
            log("update ${f.versionName}: download paused: ${e.message}")
        } catch (e: Exception) {
            failed(f, done, e) // the installer refused it
        } finally {
            synchronized(this) { queued -= f.versionCode }
        }
    }

    /** One more failed try; after 3 the version is given up (and its file removed) until a newer one. */
    private fun failed(f: UpdateFile, done: File, e: Exception) {
        val n = synchronized(this) { (tries[f.versionCode] ?: 0) + 1 }.also { synchronized(this) { tries[f.versionCode] = it } }
        if (n >= MAX_TRIES) done.delete()
        log("update ${f.versionName} failed ($n of $MAX_TRIES): ${e.javaClass.simpleName}: ${e.message}")
    }

    /** Downloads into `part`, carrying on from what is there. */
    private fun download(f: UpdateFile, part: File) {
        val have = if (part.exists()) part.length() else 0L
        if (have > f.bytes) part.delete()
        val from = if (part.exists()) part.length() else 0L
        if (from == f.bytes) return
        fetcher.fetch(f.url, from).use { got ->
            val start = got.startsAt
            FileOutputStream(part, start > 0).use { out ->
                val buf = ByteArray(64 * 1024)
                var total = start
                while (true) {
                    val n = got.body.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > f.bytes) throw BadFile("larger than ${f.bytes} bytes")
                    out.write(buf, 0, n)
                }
                out.fd.sync()
            }
        }
    }

    private fun checkFile(f: UpdateFile, file: File) {
        if (file.length() != f.bytes) throw BadFile("size ${file.length()}, expected ${f.bytes}")
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        val hex = md.digest().joinToString("") { "%02x".format(it) }
        if (hex != f.sha256) throw BadFile("fingerprint does not match")
    }

    private companion object {
        const val MAX_TRIES = 3
        /** Room always left free besides the update (ads, the play log). */
        const val SPARE_BYTES = 300L * 1024 * 1024
    }
}
