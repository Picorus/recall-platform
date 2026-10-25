// P2.12: remote commands on the box (the cloud's packages/domain/src/screen-commands.ts; shared cases
// test-vectors/screen-commands.json). Each command is carried out once: its id is kept on storage
// before anything is done (a reboot must not repeat after the reboot), and the box answers each
// one (done, refused, failed) through its outbox, so the answer reaches the cloud's log even after
// a reboot or without signal. A command that has expired, or is dated ahead of the trusted time, is
// refused. Without a trusted time a command waits (its age cannot be known): the cloud sends it again.
package app.recall.player.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

/** One command (or why it was refused, with its id when that could be read). */
data class ScreenCommand(val id: String, val screen: String, val made: Long, val until: Long, val name: String, val value: Long?)

data class ParsedCommand(val command: ScreenCommand?, val problem: String?, val id: String? = null)

object ScreenCommands {
    val NAMES = setOf("reboot", "blank", "unblank", "test-pattern", "brightness", "send-logs", "clear-cache")
    const val MAX_LIFE_MS = 3_600_000L
    const val MAX_NOTE = 4_000
    private val ID = Regex("[A-Za-z0-9-]{8,64}")
    private val KEYS = setOf("v", "id", "screen", "made", "until", "do", "value")
    private const val MAX_SAFE = (1L shl 53) - 1

    /** A whole JSON number in range (as the cloud's Number.isSafeInteger takes it), else null. */
    private fun whole(e: Any?, min: Long, max: Long = MAX_SAFE): Long? {
        val p = (e as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
        val n = p.content.toBigDecimalOrNull() ?: return null
        return runCatching { n.longValueExact() }.getOrNull()?.takeIf { it in min..max }
    }

    fun parse(text: String): ParsedCommand {
        val x = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull()
        if (x == null || x.keys != KEYS) return ParsedCommand(null, "not a command")
        val rawId = (x["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val id = rawId?.takeIf(ID::matches)
        fun no(problem: String) = ParsedCommand(null, problem, id)
        if (whole(x["v"], 1, 1) == null) return no("unknown version")
        if (id == null) return no("bad id")
        val screen = (x["screen"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(ScreenIdentity::isScreenId) ?: return no("bad screen")
        val made = whole(x["made"], 1) ?: return no("bad time")
        val until = whole(x["until"], 1)?.takeIf { it > made && it - made <= MAX_LIFE_MS } ?: return no("bad until")
        val name = (x["do"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it in NAMES } ?: return no("unknown command")
        val raw = x["value"]
        val value: Long? = when (name) {
            "brightness" -> if (raw is JsonNull) null else whole(raw, 1, 100) ?: return no("bad value")
            "test-pattern" -> whole(raw, 5, 600) ?: return no("bad value")
            else -> if (raw is JsonNull) null else return no("bad value")
        }
        return ParsedCommand(ScreenCommand(id, screen, made, until, name, value), null, id)
    }

    /** The box's answer to a command (a report through the outbox). */
    fun answer(id: String, atS: Long, result: String, note: String): JsonObject = JsonObject(
        linkedMapOf(
            "kind" to JsonPrimitive("command"),
            "id" to JsonPrimitive(id),
            "at" to JsonPrimitive(atS),
            "result" to JsonPrimitive(result),
            "note" to JsonPrimitive(printable(note).takeLast(MAX_NOTE)),
        ),
    )

    /** Printable ASCII and line breaks only (what the cloud keeps). */
    fun printable(s: String): String = s.map { if (it == '\n' || it in ' '..'~') it else '?' }.joinToString("")
}

/** What the box can be told to do. Each returns normally when done, or throws when it failed. */
interface CommandActions {
    /**
     * Arranges a restart a few seconds later (after the answer is in the outbox); throws at once,
     * restarting nothing, when the box cannot restart.
     */
    fun reboot()
    fun blank(on: Boolean)
    fun testPattern(seconds: Long)
    /** Percent, or null for automatic again. */
    fun brightness(percent: Int?)
    /** The end of the box's own log. */
    fun logs(): String
    fun clearCache()
}

class CommandRunner(
    private val dir: File,
    /** This box: a command for another screen is refused. */
    private val screenId: String,
    /** Trusted time now (UTC ms), or null while there is none. */
    private val nowMs: () -> Long?,
    private val actions: CommandActions,
    /** An answer for the cloud, made at UTC second `at` (the outbox). */
    private val send: (JsonObject, Long) -> Unit,
    private val log: (String) -> Unit = {},
) {
    private val seenFile = File(dir, "commands-done")
    /** Ids carried out (or refused), with the time each may be forgotten (ms). */
    private val seen = LinkedHashMap<String, Long>()
    private var unreadable = 0L

    /** Commands that could not be read at all (no id to answer). Health. */
    val refusedUnread: Long @Synchronized get() = unreadable

    init {
        dir.mkdirs()
        runCatching {
            (Json.parseToJsonElement(seenFile.readText()) as JsonArray).forEach { e ->
                val o = e.jsonObject
                seen[o.getValue("id").jsonPrimitive.content] = o.getValue("forget").jsonPrimitive.long
            }
        }
    }

    /** A command from the cloud (the line's thread). */
    @Synchronized
    fun onCommand(text: String) {
        val p = ScreenCommands.parse(text)
        val now = nowMs()
        val id = p.id
        if (id != null && id in seen) return // carried out (or refused) before: the cloud sent it again
        val c = p.command
        if (c == null || id == null) {
            if (id == null) {
                unreadable++
                log("command: unreadable: ${p.problem}")
            } else {
                finish(id, now, Long.MAX_VALUE, "refused", p.problem ?: "refused")
            }
            return
        }
        when {
            c.screen != screenId -> return finish(id, now, c.until, "refused", "not for this screen")
            // No trusted time yet: neither done nor answered; the cloud sends it again with the next
            // hello, by when the box has the cloud's time.
            now == null -> return log("command $id: waits for a trusted time")
            now >= c.until -> return finish(id, now, c.until, "refused", "expired")
            c.made > now + AHEAD_MS -> return finish(id, now, c.until, "refused", "dated ahead of the box's time")
        }
        // Kept before it is carried out: a reboot never repeats after the reboot. When it cannot be
        // kept (storage full), nothing is done: the cloud sends it again (review P2.12).
        if (!remember(id, c.until)) return log("command $id: not done: the done list could not be kept")
        val (result, note) = try {
            when (c.name) {
                // Checked and arranged first (it fails if the box cannot reboot), answered, then done.
                "reboot" -> actions.reboot()
                "blank" -> actions.blank(true)
                "unblank" -> actions.blank(false)
                "test-pattern" -> actions.testPattern(c.value ?: 60)
                "brightness" -> actions.brightness(c.value?.toInt())
                "send-logs" -> return answer(id, now, "done", actions.logs())
                "clear-cache" -> actions.clearCache()
            }
            "done" to ""
        } catch (e: Throwable) {
            "failed" to "${e.javaClass.simpleName}: ${e.message ?: ""}".take(200)
        }
        answer(id, now, result, note)
    }

    private fun finish(id: String, now: Long?, until: Long, result: String, note: String) {
        log("command $id: $result: $note")
        remember(id, until)
        answer(id, now, result, note)
    }

    private fun answer(id: String, now: Long?, result: String, note: String) {
        val atS = Math.floorDiv(now ?: System.currentTimeMillis(), 1000L)
        runCatching { send(ScreenCommands.answer(id, atS, result, note), atS) }
            .onFailure { log("command $id: answer not stored: ${it.javaClass.simpleName}") }
    }

    /** Adds an id to the done list on storage; false when it could not be kept. */
    private fun remember(id: String, until: Long): Boolean {
        // Only the newest 500 are kept (a few commands a day): never pruned by a clock that could be
        // wrong, so a command still on its way back is never done twice (review P2.12).
        seen[id] = until
        while (seen.size > MAX_KEPT) seen.remove(seen.keys.first())
        return runCatching {
            DiskFiles.writeAtomically(
                seenFile,
                JsonArray(seen.map { (k, v) -> JsonObject(mapOf("id" to JsonPrimitive(k), "forget" to JsonPrimitive(v))) }).toString(),
            )
        }.onFailure {
            seen.remove(id)
            log("command: done list not kept: ${it.javaClass.simpleName}")
        }.isSuccess
    }

    private companion object {
        const val AHEAD_MS = 5 * 60_000L
        const val MAX_KEPT = 500
    }
}
