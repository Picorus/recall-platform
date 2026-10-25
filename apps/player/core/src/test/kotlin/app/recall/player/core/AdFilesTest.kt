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

/** The same shared cases the cloud's TypeScript passes (packages/domain/test-vectors/ad-files.json). */
class AdFilesTest {
    private val v = Json.parseToJsonElement(
        File(System.getProperty("recall.vectors"), "ad-files.json").readText(),
    ).jsonObject

    @Test
    fun `reads the cloud's list exactly`() {
        val list = v.getValue("list").jsonObject
        val want = list.getValue("files").jsonArray.map { it.jsonObject }.map {
            AdFile(
                it.getValue("ad").jsonPrimitive.content,
                it.getValue("sha256").jsonPrimitive.content,
                it.getValue("bytes").jsonPrimitive.long,
                it.getValue("url").jsonPrimitive.content,
                it.getValue("keepUntil").jsonPrimitive.long,
            )
        }
        val got = AdFiles.parse(list.getValue("text").jsonPrimitive.content)
        assertNull(got.problem)
        assertEquals(list.getValue("made").jsonPrimitive.long, got.made)
        assertEquals(want, got.files)
    }

    @Test
    fun `refuses the same lists as the cloud, for the same reasons`() {
        for (r in v.getValue("refused").jsonArray.map { it.jsonObject }) {
            val text = r.getValue("text").jsonPrimitive.content
            val got = AdFiles.parse(text)
            assertEquals(r.getValue("problem").jsonPrimitive.content, got.problem, text)
            assertEquals(emptyList(), got.files)
        }
    }

    @Test
    fun `the list travels on its own down topic`() {
        val me = "SCR-0123456Z"
        assertEquals("recall/v1/s/$me/down/files", ScreenLink.downTopic(me, DownKind.FILES))
        assertEquals(DownKind.FILES, ScreenLink.downKind(me, "recall/v1/s/$me/down/files"))
    }
}
