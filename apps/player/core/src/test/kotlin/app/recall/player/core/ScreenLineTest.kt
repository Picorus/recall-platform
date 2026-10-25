package app.recall.player.core

import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** The line's logic against a fake broker (the real one: ScreenLineBrokerTest). */
class ScreenLineTest {
    private val me = "SCR-0123456Z"
    private val t0 = 1_790_000_000L
    private val outbox = Outbox(Files.createTempDirectory("line").toFile())
    private val clock = AtomicReference(TrustedClock())
    private val mono = { System.nanoTime() / 1_000_000 }
    private val lines = CopyOnWriteArrayList<ScreenLine>()

    @AfterTest
    fun stop() = lines.forEach { it.stop() }

    /** A broker that answers like the gateway, unless told to stay quiet. */
    inner class FakeBroker {
        val published = CopyOnWriteArrayList<Pair<String, String>>()
        val subscribed = CopyOnWriteArrayList<String>()
        val connects = AtomicInteger()
        @Volatile var refuseConnects = 0
        @Volatile var answer = true
        @Volatile var current: Conn? = null

        inner class Conn : LineTransport {
            lateinit var onMessage: (String, ByteArray) -> Unit
            lateinit var onLost: (Throwable?) -> Unit
            @Volatile var open = false

            override fun connect(onMessage: (String, ByteArray) -> Unit, onLost: (Throwable?) -> Unit) {
                if (refuseConnects > 0) {
                    refuseConnects--
                    error("refused")
                }
                this.onMessage = onMessage
                this.onLost = onLost
                open = true
                connects.incrementAndGet()
                current = this
            }

            override fun subscribe(filter: String) {
                subscribed += filter
            }

            override fun publish(topic: String, payload: ByteArray) {
                check(open) { "line gone" }
                val text = String(payload)
                published += topic to text
                if (!answer) return
                val o = Json.parseToJsonElement(text).jsonObject
                when {
                    topic.endsWith("/up/hello") ->
                        onMessage("recall/v1/s/$me/down/time", """{"utcMs":${t0 * 1000},"echo":${o.getValue("mono").jsonPrimitive.long}}""".toByteArray())
                    topic.endsWith("/up/upload") -> {
                        val top = o.getValue("batch").jsonArray.maxOfOrNull { it.jsonObject.getValue("seq").jsonPrimitive.long } ?: return
                        onMessage("recall/v1/s/$me/down/ack", """{"ack":$top}""".toByteArray())
                    }
                }
            }

            override fun close() {
                open = false
            }

            /** The broker drops the line. */
            fun drop() {
                open = false
                onLost(RuntimeException("dropped"))
            }
        }

        fun uploads() = published.filter { it.first.endsWith("/up/upload") }.map { it.second }
    }

    private fun line(broker: FakeBroker, rules: LineRules = LineRules(resendMs = 300)) =
        ScreenLine(
            me, "0.3.0", outbox, { broker.Conn() }, clock, mono, random = { 0 },
            rules = rules, backoffRules = BackoffRules(firstMs = 20, longestMs = 100),
        ).also {
            lines += it
            it.start()
        }

    private fun report(n: Int) = JsonObject(mapOf("kind" to JsonPrimitive("live"), "n" to JsonPrimitive(n)))

    private fun until(what: String, ms: Long = 5_000, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!ok()) {
            check(System.currentTimeMillis() < end) { "timed out waiting for: $what" }
            Thread.sleep(10)
        }
    }

    @Test
    fun `connects, listens on its own topics, says hello, sets its clock, uploads and forgets what is acked`() {
        (1..3).forEach { outbox.add(report(it), t0) }
        val broker = FakeBroker()
        val l = line(broker)
        until("all acked") { outbox.waiting() == 0 }
        assertEquals(listOf("recall/v1/s/$me/down/#"), broker.subscribed)
        assertEquals("recall/v1/s/$me/up/hello", broker.published.first().first)
        assertTrue(broker.published.first().second.startsWith("""{"v":1,"app":"0.3.0","mono":"""))
        // The clock is set from the cloud's reply (and from nothing else here).
        assertNotNull(clock.get().cloudNow(mono()))
        // A new report goes out soon after a nudge, as its own upload.
        outbox.add(report(4), t0)
        l.nudge()
        until("the new report acked") { outbox.waiting() == 0 }
        assertEquals(2, broker.uploads().size)
        assertTrue(broker.uploads().last().contains("\"oldestHeld\":4"))
    }

    @Test
    fun `an upload not acked is sent again, and stored once by the cloud's rules`() {
        (1..2).forEach { outbox.add(report(it), t0) }
        val broker = FakeBroker().apply { answer = false }
        line(broker)
        until("sent three times") { broker.uploads().size >= 3 }
        assertEquals(1, broker.uploads().toSet().size) // the same upload each time
        broker.answer = true
        until("acked") { outbox.waiting() == 0 }
    }

    @Test
    fun `refused connections and dropped lines are tried again, and nothing is lost`() {
        (1..2).forEach { outbox.add(report(it), t0) }
        val broker = FakeBroker().apply {
            refuseConnects = 3
            answer = false
        }
        val l = line(broker)
        until("connected after 3 refusals") { broker.connects.get() == 1 && broker.uploads().isNotEmpty() }
        broker.current!!.drop()
        broker.answer = true
        until("connected again") { broker.connects.get() == 2 }
        until("acked after reconnecting") { outbox.waiting() == 0 }
        assertTrue(l.connected)
        // Each new line says hello again (fresh time).
        assertEquals(2, broker.published.count { it.first.endsWith("/up/hello") })
    }

    @Test
    fun `stopping ends the line at once, even while waiting to try again`() {
        val broker = FakeBroker().apply { refuseConnects = Int.MAX_VALUE }
        val l = ScreenLine(
            me, "0.3.0", outbox, { broker.Conn() }, clock, mono, random = { 0 },
            backoffRules = BackoffRules(firstMs = 60_000, longestMs = 60_000),
        )
        l.start()
        Thread.sleep(100)
        val t = System.currentTimeMillis()
        l.stop()
        assertTrue(System.currentTimeMillis() - t < 2_000)
    }
}
