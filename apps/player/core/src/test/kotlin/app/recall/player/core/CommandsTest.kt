package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** P2.12: remote commands on the box, against the cloud's cases (test-vectors/screen-commands.json). */
class CommandsTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "screen-commands.json").readText()).jsonObject
    private val dir: File = Files.createTempDirectory("commands").toFile()
    private val made = 1_793_620_000_000L

    private class Fake : CommandActions {
        val done = mutableListOf<String>()
        var fail = false
        override fun reboot() { done += "reboot" }
        override fun blank(on: Boolean) { if (fail) error("panel not answering"); done += "blank $on" }
        override fun testPattern(seconds: Long) { done += "test $seconds" }
        override fun brightness(percent: Int?) { done += "brightness $percent" }
        override fun logs(): String = "line one\nline two é"
        override fun clearCache() { done += "clear" }
    }

    private val answers = mutableListOf<JsonObject>()
    private var now: Long? = made + 1_000
    private val fake = Fake()
    private val me = v.getValue("screen").jsonPrimitive.content
    private fun runner() = CommandRunner(dir, me, { now }, fake, { r, _ -> answers += r })
    private fun text(name: String, value: Any?, id: String = "c-$name-0001", until: Long = made + 600_000, screen: String = me) =
        """{"v":1,"id":"$id","screen":"$screen","made":$made,"until":$until,"do":"$name","value":${value ?: "null"}}"""
    private fun s(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.content

    @Test
    fun `the box reads and refuses exactly as the cloud`() {
        for (t in v.getValue("taken").jsonArray.map { it.jsonObject }) {
            val c = t.getValue("command").jsonObject
            val p = ScreenCommands.parse(t.getValue("text").jsonPrimitive.content)
            val value = c.getValue("value").takeIf { it !is JsonNull }?.jsonPrimitive?.long
            assertEquals(ScreenCommand(s(c, "id"), s(c, "screen"), c.getValue("made").jsonPrimitive.long, c.getValue("until").jsonPrimitive.long, s(c, "do"), value), p.command)
        }
        for (r in v.getValue("refused").jsonArray.map { it.jsonObject }) {
            val p = ScreenCommands.parse(r.getValue("text").jsonPrimitive.content)
            assertEquals(s(r, "problem"), p.problem, r.getValue("text").jsonPrimitive.content)
        }
    }

    @Test
    fun `each command is carried out once and answered`() {
        val r = runner()
        r.onCommand(text("blank", null))
        r.onCommand(text("blank", null)) // sent again on reconnect
        r.onCommand(text("brightness", 40))
        r.onCommand(text("brightness", null, id = "c-bright-auto"))
        r.onCommand(text("test-pattern", 30))
        r.onCommand(text("clear-cache", null))
        r.onCommand(text("unblank", null))
        assertEquals(listOf("blank true", "brightness 40", "brightness null", "test 30", "clear", "blank false"), fake.done)
        assertEquals(6, answers.size)
        assertTrue(answers.all { s(it, "result") == "done" })
        // After a restart the box still knows what it did.
        runner().onCommand(text("blank", null))
        assertEquals(6, fake.done.size)
    }

    @Test
    fun `expired, dated ahead, unreadable and failed commands`() {
        val r = runner()
        now = made + 600_001
        r.onCommand(text("reboot", null))
        now = made - 10 * 60_000
        r.onCommand(text("blank", null, id = "c-ahead-00001"))
        now = made + 1_000
        r.onCommand(text("brightness", 0, id = "c-bad-value-1"))
        r.onCommand("not json")
        fake.fail = true
        r.onCommand(text("blank", null, id = "c-fails-0001"))
        assertEquals(listOf("expired", "dated ahead of the box's time", "bad value"), answers.take(3).map { s(it, "note") })
        assertEquals(listOf("refused", "refused", "refused", "failed"), answers.map { s(it, "result") })
        assertTrue(s(answers[3], "note").contains("panel not answering"))
        assertEquals(1L, r.refusedUnread)
        assertTrue("reboot" !in fake.done)
    }

    @Test
    fun `a command for another screen is refused, and one that cannot be kept is not done`() {
        val r = runner()
        r.onCommand(text("reboot", null, screen = "SCR-7654321M")) // another valid screen
        assertEquals("not for this screen", s(answers.single(), "note"))
        assertTrue(fake.done.isEmpty())
        // Storage refuses the done list: nothing is done, nothing answered; the cloud sends it again.
        val full = Files.createTempDirectory("full").toFile()
        File(full, "commands-done.tmp").mkdirs() // the write cannot even begin
        CommandRunner(full, me, { now }, fake, { r2, _ -> answers += r2 }).onCommand(text("reboot", null, id = "c-reboot-full"))
        assertTrue(fake.done.isEmpty())
        assertEquals(1, answers.size)
    }

    @Test
    fun `without a trusted time a command waits, and is done when it comes again`() {
        now = null
        val r = runner()
        r.onCommand(text("blank", null))
        assertEquals(emptyList(), fake.done)
        assertEquals(emptyList(), answers)
        now = made + 2_000
        r.onCommand(text("blank", null))
        assertEquals(listOf("blank true"), fake.done)
    }

    @Test
    fun `a reboot is answered before it happens, and never repeats after it`() {
        val r = runner()
        r.onCommand(text("reboot", null))
        assertEquals(listOf("reboot"), fake.done)
        assertEquals("done", s(answers.single(), "result"))
        runner().onCommand(text("reboot", null)) // after the reboot, the cloud's resend
        assertEquals(listOf("reboot"), fake.done)
    }

    @Test
    fun `logs go back as printable text, cut to the cloud's limit`() {
        val r = runner()
        r.onCommand(text("send-logs", null))
        assertEquals("line one\nline two ?", s(answers.single(), "note"))
        val long = ScreenCommands.answer("c-long-00001", 1, "done", "x".repeat(5_000))
        assertEquals(ScreenCommands.MAX_NOTE, s(long, "note").length)
    }
}
