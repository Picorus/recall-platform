// P2.3: the line to the cloud. The same topics and message text as packages/domain/src/screen-link.ts,
// checked against the same shared cases (packages/domain/test-vectors/screen-link.json). What travels
// is the upload of P1.2.5: numbered reports and the smallest number the box still holds, answered by
// one number (everything up to it is stored).
package app.recall.player.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/** What a screen sends: a hello when the line opens (asks for the time), and uploads. */
enum class UpKind { HELLO, UPLOAD }

/** What the cloud sends to a screen. */
enum class DownKind { ACK, TIME, PLAN, COMMAND }

object ScreenLink {
    const val TOPIC_ROOT = "recall/v1/s"
    /** Most reports in one upload (the cloud refuses more). */
    const val MAX_BATCH = 500
    /** Largest upload the cloud takes, in bytes. */
    const val MAX_UP_BYTES = 256 * 1024

    fun upTopic(screenId: String, kind: UpKind) = "$TOPIC_ROOT/$screenId/up/${kind.name.lowercase()}"
    fun downTopic(screenId: String, kind: DownKind) = "$TOPIC_ROOT/$screenId/down/${kind.name.lowercase()}"
    /** Everything the cloud may send this screen. */
    fun downFilter(screenId: String) = "$TOPIC_ROOT/$screenId/down/#"

    /** The kind of a message on this screen's down topics, or null when it is not one. */
    fun downKind(screenId: String, topic: String): DownKind? {
        val prefix = "$TOPIC_ROOT/$screenId/down/"
        if (!topic.startsWith(prefix)) return null
        val name = topic.removePrefix(prefix)
        return DownKind.entries.firstOrNull { it.name.lowercase() == name }
    }

    /** One numbered report, as stored in the outbox and sent. `at`: when made, UTC seconds. */
    fun numberedText(seq: Long, at: Long, report: JsonObject) = """{"seq":$seq,"at":$at,"report":$report}"""

    /** An upload, from stored numbered reports. */
    fun uploadText(numbered: List<String>, oldestHeld: Long) =
        """{"v":1,"oldestHeld":$oldestHeld,"batch":[${numbered.joinToString(",")}]}"""

    /** A hello: the app version and the box's own counter (ms), echoed back with the cloud's time. */
    fun helloText(app: String, mono: Long) = """{"v":1,"app":${JsonPrimitive(app)},"mono":$mono}"""

    /** The cloud's reply to an upload: everything up to this number is stored. Null when not one. */
    fun parseAck(text: String): Long? = runCatching {
        number(Json.parseToJsonElement(text).jsonObject.getValue("ack"))
    }.getOrNull()

    /** The cloud's time reply: its time (UTC ms) and our counter echoed from the hello. */
    fun parseTime(text: String): Pair<Long, Long>? = runCatching {
        val o = Json.parseToJsonElement(text).jsonObject
        number(o.getValue("utcMs")) to number(o.getValue("echo"))
    }.getOrNull()

    /** A whole number written as a number (not as text). */
    private fun number(e: JsonElement): Long {
        val p = e as JsonPrimitive
        require(!p.isString)
        return requireNotNull(p.longOrNull)
    }
}
