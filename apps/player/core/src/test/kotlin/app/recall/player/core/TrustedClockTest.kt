package app.recall.player.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TrustedClockTest {
    private val t = 1_790_000_000_000L

    @Test
    fun `unknown until a source is heard, then runs on the counter`() {
        val c = TrustedClock()
        assertNull(c.now(5_000))
        val g = c.withGps(t, monoMs = 5_000)
        assertEquals(t + 60_000, g.now(65_000))
        assertEquals(500L + 12, g.doubtMs(65_000)) // 60 s at 200 ppm
    }

    @Test
    fun `the cloud's time is taken at the middle of the round trip, slow replies are not used`() {
        val c = TrustedClock().withCloud(t, sentMono = 1_000, receivedMono = 1_400)
        assertEquals(t + 800, c.now(2_000))
        assertEquals(201L, c.doubtMs(1_200))
        assertNull(TrustedClock().withCloud(t, 1_000, 12_000).now(12_000))
        assertNull(TrustedClock().withCloud(t, 1_000, 900).now(1_000))
    }

    @Test
    fun `unbelievable times (a GPS roll-over to 2006) are ignored`() {
        assertNull(TrustedClock().withGps(1_136_073_600_000L, 0).now(0))
        assertNull(TrustedClock().withCloud(4_200_000_000_000L, 0, 10).now(0))
    }

    @Test
    fun `the source with less doubt wins, if they disagree by over 10 s the cloud wins and it is flagged`() {
        // A fresh GPS fix beats a cloud reply with a 2-second round trip.
        val both = TrustedClock().withCloud(t, 0, 2_000).withGps(t + 1_500, 1_000)
        assertEquals(t + 1_500, both.now(1_000))
        assertFalse(both.disagree(1_000))
        // An hour later the old GPS fix has drifted doubt; a fresh cloud reply wins.
        val later = both.withCloud(t + 3_600_000, 3_600_000, 3_600_100)
        assertEquals(t + 3_600_000, later.now(3_600_050))
        // Faked GPS, 5 minutes ahead: the cloud wins, and the box reports it.
        val faked = TrustedClock().withCloud(t, 0, 100).withGps(t + 300_000, 100)
        assertTrue(faked.disagree(100))
        assertEquals(t + 50, faked.now(100))
    }

    @Test
    fun `a reading from before the counter restarted is never used`() {
        val c = TrustedClock().withGps(t, monoMs = 50_000)
        assertNull(c.now(10_000))
        assertFalse(c.withCloud(t, 0, 100).disagree(10_000))
    }
}
