package app.recall.player.core

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** P2.13: player updates on the box, against the cloud's cases (test-vectors/updates.json). */
class UpdatesTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "updates.json").readText()).jsonObject
    private val dir: File = Files.createTempDirectory("updates").toFile()
    private val apk = ByteArray(300_000) { (it * 31 % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(apk).joinToString("") { "%02x".format(it) }
    private fun msg(code: Int, sha256: String = sha, bytes: Int = apk.size) =
        """{"v":1,"made":1793620000000,"versionCode":$code,"versionName":"0.$code.0","sha256":"$sha256","bytes":$bytes,"url":"https://files.recall.example/p/$code.apk"}"""

    private val installed = mutableListOf<Pair<File, Int>>()
    private val asked = mutableListOf<Long>()
    /** Serves the file; the first fetch is cut after `cutAt` bytes when set. */
    private var cutAt: Int? = null
    private val fetcher = Fetcher { _, from ->
        asked += from
        val rest = apk.copyOfRange(from.toInt(), apk.size)
        val cut = cutAt
        val body: InputStream = if (cut == null) ByteArrayInputStream(rest) else object : InputStream() {
            var i = 0
            override fun read(): Int {
                if (i >= cut) throw IOException("signal lost")
                return if (i < rest.size) rest[i++].toInt() and 0xff else -1
            }
        }
        cutAt = null
        Fetched(from, body)
    }
    private var free = Long.MAX_VALUE
    private fun updater(own: Int = 10) = Updater(dir, own, fetcher, { f, u -> installed += f to u.versionCode }, run = { it.run() }, freeBytes = { free })

    @Test
    fun `the box reads and refuses exactly as the cloud`() {
        for (t in v.getValue("taken").jsonArray.map { it.jsonObject }) {
            val (file, problem) = UpdateMessages.parse(t.getValue("text").jsonPrimitive.content)
            val f = t.getValue("file").jsonObject
            assertEquals(null, problem)
            assertEquals(f.getValue("versionCode").jsonPrimitive.long.toInt(), file?.versionCode)
            assertEquals(f.getValue("sha256").jsonPrimitive.content, file?.sha256)
            assertEquals(f.getValue("made").jsonPrimitive.long, file?.made)
        }
        for (r in v.getValue("refused").jsonArray.map { it.jsonObject }) {
            assertEquals(r.getValue("problem").jsonPrimitive.content, UpdateMessages.parse(r.getValue("text").jsonPrimitive.content).second)
        }
    }

    @Test
    fun `a newer version is downloaded, checked and installed, never an older or the same one`() {
        val u = updater(own = 10)
        assertFalse(u.onUpdate(msg(10)))
        assertFalse(u.onUpdate(msg(9)))
        assertTrue(u.onUpdate(msg(11)))
        assertEquals(1, installed.size)
        assertEquals(11, installed[0].second)
        assertTrue(installed[0].first.readBytes().contentEquals(apk))
    }

    @Test
    fun `a download cut by a weak link carries on where it stopped`() {
        cutAt = 100_000
        val u = updater()
        u.onUpdate(msg(12)) // cut: fails this time
        assertTrue(installed.isEmpty())
        u.onUpdate(msg(12)) // the next offer carries on
        assertEquals(listOf(0L, 100_000L), asked)
        assertTrue(installed.single().first.readBytes().contentEquals(apk))
    }

    @Test
    fun `a wrong file is thrown away, and a version that keeps failing is given up after 3 tries`() {
        val u = updater()
        repeat(5) { u.onUpdate(msg(13, sha256 = "0".repeat(64))) }
        assertTrue(installed.isEmpty())
        assertEquals(3, asked.size, "tried 3 times, then left until a newer version")
        assertFalse(File(dir, "player-13.apk").exists())
        assertFalse(File(dir, "player-13.part").exists())
        assertTrue(u.onUpdate(msg(14)), "a newer version is tried")
        assertEquals(14, installed.single().second)
    }

    @Test
    fun `a file larger than offered is refused, and leftovers of older versions go at start`() {
        File(dir, "player-9.apk").writeText("old")
        File(dir, "player-15.part").writeText("x")
        val u = updater(own = 10)
        assertFalse(File(dir, "player-9.apk").exists())
        assertTrue(File(dir, "player-15.part").exists())
        u.onUpdate(msg(16, bytes = 1_000))
        assertTrue(installed.isEmpty())
        assertFalse(File(dir, "player-16.part").exists())
    }

    @Test
    fun `a weak link never makes the box give up, and an update never takes the room ads need`() {
        val u = updater()
        repeat(5) {
            cutAt = 10
            u.onUpdate(msg(17))
        }
        assertTrue(installed.isEmpty())
        u.onUpdate(msg(17))
        assertEquals(17, installed.single().second, "carried on after 5 cuts")
        free = 100_000_000 // 100 MB: less than the file plus the room kept free
        val before = asked.size
        assertTrue(u.onUpdate(msg(18)))
        assertEquals(before, asked.size, "nothing downloaded")
        assertFalse(File(dir, "player-17.apk").exists(), "older files cleared for the new offer")
    }
}
