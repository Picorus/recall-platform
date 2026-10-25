package app.recall.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The same shared cases the cloud's TypeScript passes (packages/domain/test-vectors). */
class ScreenLinkTest {
    private val v = Json.parseToJsonElement(
        File(System.getProperty("recall.vectors"), "screen-link.json").readText(),
    ).jsonObject

    private fun str(o: Map<String, *>, k: String) = (o[k] as kotlinx.serialization.json.JsonElement).jsonPrimitive.content

    @Test
    fun `topics, upload text and hello match the cloud`() {
        for (t in v.getValue("topics").jsonArray.map { it.jsonObject }) {
            val kind = UpKind.valueOf(str(t, "kind").uppercase())
            assertEquals(str(t, "up"), ScreenLink.upTopic(str(t, "screenId"), kind))
        }
        for (t in v.getValue("downTopics").jsonArray.map { it.jsonObject }) {
            val id = str(t, "screenId")
            val kind = DownKind.valueOf(str(t, "kind").uppercase())
            assertEquals(str(t, "down"), ScreenLink.downTopic(id, kind))
            assertEquals(kind, ScreenLink.downKind(id, ScreenLink.downTopic(id, kind)))
        }
        val up = v.getValue("upload").jsonObject
        val lines = up.getValue("batch").jsonArray.map { it.jsonObject }.map {
            ScreenLink.numberedText(it.getValue("seq").jsonPrimitive.long, it.getValue("at").jsonPrimitive.long, it.getValue("report").jsonObject)
        }
        assertEquals(str(up, "text"), ScreenLink.uploadText(lines, up.getValue("oldestHeld").jsonPrimitive.long))
        val hello = v.getValue("hello").jsonObject
        assertEquals(str(hello, "text"), ScreenLink.helloText(str(hello, "app"), hello.getValue("mono").jsonPrimitive.long))
    }

    @Test
    fun `acks and time replies from the cloud are read, anything else is not`() {
        val ack = v.getValue("ack").jsonObject
        assertEquals(ack.getValue("ack").jsonPrimitive.long, ScreenLink.parseAck(str(ack, "text")))
        val time = v.getValue("time").jsonObject
        assertEquals(
            time.getValue("utcMs").jsonPrimitive.long to time.getValue("echo").jsonPrimitive.long,
            ScreenLink.parseTime(str(time, "text")),
        )
        assertNull(ScreenLink.parseAck("""{"ack":"42"}"""))
        assertNull(ScreenLink.parseAck("""{"ack":4.5}"""))
        assertNull(ScreenLink.parseAck("not json"))
        assertNull(ScreenLink.parseTime("""{"utcMs":"1790000000000","echo":1}"""))
        assertNull(ScreenLink.downKind("SCR-0123456Z", "recall/v1/s/SCR-00000000/down/ack"))
        assertNull(ScreenLink.downKind("SCR-0123456Z", "recall/v1/s/SCR-0123456Z/down/money"))
    }
}
