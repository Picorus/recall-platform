// P2.3.3: the box's line to the cloud, kept open by itself (plan: "reconnects by itself"). One thread:
//  1. Connect (TLS, P2.3.1 Backoff between tries: 1, 2, 4 … 60 s, random part).
//  2. Listen on its own down topics, then say hello (the cloud answers with its time, which sets the
//     box's clock, P2.3.1 TrustedClock).
//  3. Send the oldest unconfirmed reports from the outbox (P2.3.1 Outbox), one upload at a time. The
//     cloud's ack ("stored up to N") lets the box forget them and send the next. An upload not acked
//     within 30 s is sent again (the cloud stores each report once, however often it comes).
//  4. Say hello again every 15 minutes (the clock stays checked against the cloud).
// A line that drops goes back to 1. Nothing here decides what a report says; it only carries them.
package app.recall.player.core

import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

data class LineRules(
    /** An upload not acked within this is sent again. */
    val resendMs: Long = 30_000,
    /** A hello (and so a fresh time from the cloud) at least this often. */
    val helloEveryMs: Long = 15 * 60_000,
) {
    init {
        require(resendMs > 0 && helloEveryMs > 0)
    }
}

class ScreenLine(
    private val screenId: String,
    private val appVersion: String,
    private val outbox: Outbox,
    /** A new connection for each try (the real one: PahoTransport). */
    private val transport: () -> LineTransport,
    /** The box's clock, shared with the GPS service (P2.8). */
    private val clock: AtomicReference<TrustedClock>,
    /** The monotonic counter, ms (SystemClock.elapsedRealtime on the box). */
    private val mono: () -> Long,
    private val random: (Long) -> Long,
    private val log: (String) -> Unit = {},
    private val rules: LineRules = LineRules(),
    private val backoffRules: BackoffRules = BackoffRules(),
) {
    private sealed interface Event {
        data class Message(val topic: String, val payload: ByteArray) : Event
        data class Lost(val cause: Throwable?) : Event
        data object Nudge : Event
        data object Stop : Event
    }

    private val events = LinkedBlockingQueue<Event>()
    @Volatile private var running = false
    @Volatile var connected = false
        private set
    private var thread: Thread? = null

    fun start() {
        if (running) return
        running = true
        thread = Thread(::run, "recall-line").apply {
            isDaemon = true
            start()
        }
    }

    /** Stops the line (waits for its thread up to `waitMs`). */
    fun stop(waitMs: Long = 5_000) {
        running = false
        events.put(Event.Stop)
        thread?.join(waitMs)
    }

    /** A report was added to the outbox: send soon rather than at the next check. */
    fun nudge() {
        events.offer(Event.Nudge)
    }

    private fun run() {
        var backoff = Backoff()
        while (running) {
            val t = runCatching(transport).getOrElse {
                log("line: cannot make a connection: ${it.message}")
                null
            }
            if (t != null) {
                try {
                    events.clear()
                    t.connect({ topic, payload -> events.put(Event.Message(topic, payload)) }, { events.put(Event.Lost(it)) })
                    connected = true
                    backoff = backoff.connected(mono())
                    log("line: connected")
                    t.subscribe(ScreenLink.downFilter(screenId))
                    connectedLoop(t)
                } catch (e: Exception) {
                    log("line: ${e.javaClass.simpleName}: ${e.message}")
                } finally {
                    connected = false
                    t.close()
                }
            }
            if (!running) break
            backoff = backoff.dropped(mono(), backoffRules)
            val (wait, next) = backoff.failed(backoffRules, random)
            backoff = next
            log("line: trying again in ${wait / 1000} s")
            // Wait, but leave at once when stopped.
            val until = mono() + wait
            while (running) {
                val left = until - mono()
                if (left <= 0) break
                if (events.poll(left, TimeUnit.MILLISECONDS) == Event.Stop) break
            }
        }
    }

    /** Runs while the line is up; returns when it drops or the line is stopped. */
    private fun connectedLoop(t: LineTransport) {
        var inFlightUpTo: Long? = null
        var sentAt = 0L
        var helloAt = Long.MIN_VALUE / 2
        while (running) {
            val now = mono()
            if (now - helloAt >= rules.helloEveryMs) {
                t.publish(ScreenLink.upTopic(screenId, UpKind.HELLO), ScreenLink.helloText(appVersion, now).toByteArray())
                helloAt = now
            }
            if (inFlightUpTo == null || now - sentAt >= rules.resendMs) {
                val batch = outbox.nextBatch()
                if (batch.isNotEmpty()) {
                    val text = ScreenLink.uploadText(batch.map { it.text }, outbox.oldestHeld())
                    t.publish(ScreenLink.upTopic(screenId, UpKind.UPLOAD), text.toByteArray())
                    inFlightUpTo = batch.last().seq
                    sentAt = now
                } else {
                    inFlightUpTo = null
                }
            }
            val wait = minOf(1_000L, rules.resendMs)
            when (val e = events.poll(wait, TimeUnit.MILLISECONDS)) {
                null, Event.Nudge -> {}
                Event.Stop -> return
                is Event.Lost -> {
                    log("line: dropped (${e.cause?.message ?: "no reason"})")
                    return
                }
                is Event.Message -> when (ScreenLink.downKind(screenId, e.topic)) {
                    DownKind.ACK -> ScreenLink.parseAck(String(e.payload))?.let { n ->
                        outbox.acknowledge(n)
                        // Acks can come out of order: only the one covering what was sent frees the line.
                        if (inFlightUpTo != null && n >= inFlightUpTo!!) inFlightUpTo = null
                    }
                    DownKind.TIME -> ScreenLink.parseTime(String(e.payload))?.let { (utcMs, echo) ->
                        val c = clock.updateAndGet { it.withCloud(utcMs, sentMono = echo, receivedMono = mono()) }
                        // Reports past 7 days are given up only by a time the cloud backs (P2.3.1).
                        c.cloudNow(mono())?.let { ms -> outbox.trim(ms / 1000) }
                    }
                    else -> {} // plans and commands: later steps (P2.6, P2.12)
                }
            }
        }
    }
}
