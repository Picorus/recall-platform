package app.recall.player.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class BackoffTest {
    @Test
    fun `waits double up to a minute, each in the top half of its ceiling`() {
        var b = Backoff()
        val lowest = mutableListOf<Long>()
        val highest = mutableListOf<Long>()
        repeat(9) {
            val (low, _) = b.failed { 0 }
            val (high, next) = b.failed { n -> n - 1 }
            lowest += low
            highest += high
            b = next
        }
        assertEquals(listOf(500L, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000), lowest)
        assertEquals(listOf(1_000L, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000), highest)
    }

    @Test
    fun `a line that stayed up a minute starts over, a short one does not`() {
        var b = Backoff()
        repeat(5) { b = b.failed { 0 }.second }
        assertEquals(Backoff(5), b.connected(1_000).dropped(30_000))
        assertEquals(Backoff(), b.connected(1_000).dropped(61_000))
        assertTrue(b.failed { 0 }.first >= 8_000)
    }
}
