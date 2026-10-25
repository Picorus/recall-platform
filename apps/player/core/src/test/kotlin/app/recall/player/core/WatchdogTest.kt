package app.recall.player.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class WatchdogTest {
    private val rules = WatchdogRules()

    /** Runs the watchdog every second from `from` to `to` (ms); `beat(t)` gives the last heartbeat. */
    private fun run(
        start: WatchdogState,
        from: Long,
        to: Long,
        beat: (Long) -> Long?,
    ): Pair<List<Pair<Long, WatchdogStep.Restart>>, WatchdogState> {
        var s = start
        val restarts = mutableListOf<Pair<Long, WatchdogStep.Restart>>()
        var t = from
        while (t <= to) {
            val (step, next) = s.check(t, beat(t), rules)
            if (step is WatchdogStep.Restart) restarts += t to step
            s = next
            t += 1_000
        }
        return restarts to s
    }

    @Test
    fun `a beating player is left alone`() {
        val (restarts, _) = run(WatchdogState(), 0, 60_000) { it - 500 }
        assertEquals(emptyList(), restarts)
    }

    @Test
    fun `a crashed player is restarted within 5 seconds`() {
        // Beats until 10 s, then stops (crash at 10.2 s).
        val (restarts, _) = run(WatchdogState(), 0, 20_000) { t -> minOf(t, 10_000) }
        val first = restarts.first().first
        assertTrue(first - 10_200 <= 5_000, "restarted at $first")
        assertEquals(false, restarts.first().second.crashLoop)
    }

    @Test
    fun `a player that never comes back is retried, quickly at first, then with growing pauses and an alert`() {
        val (restarts, _) = run(WatchdogState(), 0, 10 * 60_000) { null }
        val times = restarts.map { it.first }
        val gaps = times.zipWithNext { a, b -> b - a }
        // Three quick restarts (each judged again after 3 s), then pauses of 5, 10, 20, 40, 60, 60 s …
        assertEquals(listOf(3_000L, 3_000L, 3_000L, 5_000L, 10_000L, 20_000L, 40_000L, 60_000L), gaps.take(8))
        assertTrue(gaps.all { it <= 60_000 })
        assertEquals(listOf(false, false, false, true), restarts.take(4).map { it.second.crashLoop })
    }

    @Test
    fun `crashes spread out over the day never count as a loop`() {
        var s = WatchdogState()
        repeat(20) { i ->
            val t = i * 15 * 60_000L
            val (step, next) = s.check(t, t - 10_000, rules)
            assertEquals(WatchdogStep.Restart(crashLoop = false), step)
            s = next
        }
    }
}
