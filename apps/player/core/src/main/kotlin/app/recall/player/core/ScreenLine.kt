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
    /** What the line does not handle itself: ad file lists (P2.4), later plans and commands. */
    private val onMessage: (DownKind, ByteArray) -> Unit = { _, _ -> },
    private val rules: LineRules = LineRules(),
    private val backoffRules: BackoffRules = BackoffRules(),
    /** The player's version code, sent with each hello (P2.13); null for none. */
    private val appCode: Int? = null,
) {
    private sealed interface Event {
        /** `at`: the counter when it arrived (not when the loop got to it, review P2.3.3). */
        data class Message(val topic: String, val payload: ByteArray, val at: Long) : Event
        data class Lost(val cause: Throwable?) : Event
        data object Nudge : Event
        data object Stop : Event
    }

    private val events = LinkedBlockingQueue<Event>()
    @Volatile private var running = false
    @Volatile var connected = false
        private set
    /** Reports renumbered because the cloud had their numbers already (should stay 0; health, P2.11). */
    @Volatile var renumbered = 0L
        private set
    /** True while one upload has been sent many times without an ack (health alarm, P2.11). */
    @Volatile var stuck = false
        private set
    private var thread: Thread? = null

    @Synchronized
    fun start() {
        if (running) return
        running = true
        thread = Thread(::run, "recall-line").apply {
            isDaemon = true
            start()
        }
    }

    /** Stops the line (waits for its thread up to `waitMs`). */
    @Synchronized
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
                    t.connect({ topic, payload -> events.put(Event.Message(topic, payload, mono())) }, { events.put(Event.Lost(it)) })
                    connected = true
                    backoff = backoff.connected(mono())
                    log("line: connected")
                    t.subscribe(ScreenLink.downFilter(screenId))
                    connectedLoop(t)
                } catch (e: Throwable) {
                    // Anything, even an Error: the line must keep trying, never die quietly.
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
        var sameFirst = 0L
        var sends = 0
        var helloAt = Long.MIN_VALUE / 2
        var helloMono: Long? = null
        while (running) {
            val now = mono()
            if (now - helloAt >= rules.helloEveryMs) {
                t.publish(ScreenLink.upTopic(screenId, UpKind.HELLO), ScreenLink.helloText(appVersion, now, appCode).toByteArray())
                helloAt = now
                helloMono = now
            }
            if (inFlightUpTo == null || now - sentAt >= rules.resendMs) {
                val batch = outbox.nextBatch()
                if (batch.isNotEmpty()) {
                    val text = ScreenLink.uploadText(batch.map { it.text }, outbox.oldestHeld())
                    t.publish(ScreenLink.upTopic(screenId, UpKind.UPLOAD), text.toByteArray())
                    // The same first report sent again and again: the cloud refuses it (health alarm).
                    val first = batch.first().seq
                    sends = if (first == sameFirst) sends + 1 else 1
                    sameFirst = first
                    if (sends == STUCK_AFTER) log("line: upload from $first sent $sends times without an ack")
                    stuck = sends >= STUCK_AFTER
                    inFlightUpTo = batch.last().seq
                    sentAt = now
                } else {
                    inFlightUpTo = null
                    stuck = false
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
                is Event.Message -> when (val kind = ScreenLink.downKind(screenId, e.topic)) {
                    DownKind.ACK -> ScreenLink.parseAck(String(e.payload))?.let { n ->
                        if (outbox.acknowledge(n)) {
                            // Acks can come out of order: only one covering what was sent frees the line.
                            if (inFlightUpTo != null && n >= inFlightUpTo!!) inFlightUpTo = null
                        } else if (n > outbox.lastNumber()) {
                            // The cloud has numbers this box never gave: its numbering started again.
                            val moved = outbox.renumberAfter(n)
                            renumbered += moved
                            log("line: the cloud is at $n, beyond this box's numbers: $moved reports renumbered")
                            inFlightUpTo = null
                        }
                    }
                    DownKind.TIME -> ScreenLink.parseTime(String(e.payload))?.let { (utcMs, echo) ->
                        // Only the answer to the last hello (its counter echoed back) is used.
                        if (echo == helloMono) {
                            val c = clock.updateAndGet { it.withCloud(utcMs, sentMono = echo, receivedMono = e.at) }
                            // Reports past 7 days are given up only by a time the cloud backs (P2.3.1).
                            c.cloudNow(mono())?.let { ms -> outbox.trim(ms / 1000) }
                        }
                    }
                    // Ad file lists (P2.4); plans and commands: later steps (P2.6, P2.12).
                    else -> kind?.let { k ->
                        runCatching { onMessage(k, e.payload) }.onFailure { log("line: ${k.name.lowercase()} not handled: ${it.message}") }
                    }
                }
            }
        }
    }

    private companion object {
        /** Sends of the same upload without an ack before the alarm. */
        const val STUCK_AFTER = 5
    }
}
