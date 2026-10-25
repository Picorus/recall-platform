package app.recall.player.core

import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ConductorTest {
    /** 18:00 India time on 2 Nov 2026 is 12:30 UTC: hours start on the half hour in UTC. */
    private val hour = 1_793_622_600L
    private val h0 = hour * 1000
    private val plan = HourPlan(
        "madhapur", hour,
        listOf(PlanLine("L1", "paid", listOf("a1", "a2", "a3"))),
        listOf(SpotDemand("D1", "make-up", listOf("d1"))),
        listOf("r1", "r2"),
    )
    private val carry = Carry("L1", "D1")
    private val here = mutableSetOf("a1", "a2", "a3", "d1", "r1", "r2", "n1")
    private fun fileOf(ad: String) = if (ad in here) File("/ads/$ad") else null

    /** The box's counter and the trusted time, moved on by the conductor's waits. */
    inner class Time(start: Long?, private val stopAt: Long) {
        var mono = 0L
        /** Trusted time minus counter; null: no trusted time. */
        var offset: Long? = start
        val waits = mutableListOf<Long>()
        /** Things to do when the counter passes a point (a clock correction, …). */
        val at = sortedMapOf<Long, () -> Unit>()
        val waiter = Waiter { target ->
            waits += target
            if (target >= stopAt) return@Waiter false
            while (at.isNotEmpty() && at.firstKey() <= target) {
                val k = at.firstKey()
                mono = maxOf(mono, k)
                at.remove(k)!!()
            }
            mono = maxOf(mono, target)
            true
        }
        fun utc(m: Long) = offset?.let { m + it }
    }

    inner class Screen : Renderer {
        val events = CopyOnWriteArrayList<Triple<String, Long, Spot>>()
        lateinit var time: Time
        override fun prepare(spot: Spot) {
            events += Triple("prepare", time.mono, spot)
        }
        override fun show(spot: Spot) {
            events += Triple("show", time.mono, spot)
        }
        fun shows() = events.filter { it.first == "show" }
    }

    private fun conductor(time: Time, screen: Screen, plans: PlanSource = PlanSource { t -> (plan to carry).takeIf { t >= h0 && t < h0 + 3_600_000 } }, played: MutableList<Played> = mutableListOf(), bad: MutableList<String> = mutableListOf()): Pair<Conductor, Playout> {
        screen.time = time
        val playout = Playout(plans, ::fileOf)
        return Conductor(playout, screen, time::utc, { time.mono }, time.waiter, { played += it }, { bad += it }) to playout
    }

    @Test
    fun `a whole hour on the second - 200 brand plays, 40 RECALL spots, ads in turn, each loaded ahead`() {
        val time = Time(h0, stopAt = 3_600_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        conductor(time, screen, played = played).first.run()
        val shows = screen.shows()
        assertEquals(240, shows.size)
        shows.forEachIndexed { i, (_, m, s) ->
            assertEquals(i * 15_000L, m, "spot $i on its second")
            assertEquals(h0 + i * 15_000L, s.startUtc)
            assertEquals(i, s.index)
        }
        val kinds = shows.map { it.third.shows!! }
        assertEquals(200, kinds.count { it.kind == "brand" })
        assertEquals(40, kinds.count { it.kind == "make-up" && it.ad == "d1" })
        assertEquals(listOf("a1", "a2", "a3", "a1", "a2", "d1", "a3"), kinds.take(7).map { it.ad })
        // Every spot after the first was loaded at least 2 s before it showed.
        for ((_, m, s) in shows.drop(1)) {
            val prepared = screen.events.first { it.first == "prepare" && it.third == s }.second
            assertTrue(m - prepared >= 2_000, "prepared ${m - prepared} ms ahead")
        }
        assertEquals(240, played.size)
        assertTrue(played.all { it.whole && it.ok && it.spot.timed })
    }

    @Test
    fun `starting part-way through a spot joins it but never counts it, then keeps to the second`() {
        val time = Time(h0 + 4_000, stopAt = 60_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        conductor(time, screen, played = played).first.run()
        val shows = screen.shows()
        assertEquals(listOf(0L, 11_000L, 26_000L, 41_000L, 56_000L), shows.map { it.second })
        assertEquals(listOf(false, true, true, true, true), played.map { it.whole })
    }

    @Test
    fun `a planned ad not on the box - a RECALL ad plays instead and says so, else the slate`() {
        here -= "a2"
        val time = Time(h0, stopAt = 60_000)
        val screen = Screen()
        val (c, _) = conductor(time, screen)
        c.run()
        val second = screen.shows()[1].third
        assertEquals("a2", second.planned!!.ad)
        assertEquals(SpotChoice("recall", null, "r2"), second.shows)
        assertEquals(1L, c.missingAds, "counted when shown, once")
        here -= setOf("r1", "r2")
        val bare = Playout({ plan to carry }, ::fileOf).spotAt(h0 + 15_000)
        assertNull(bare.shows)
        assertNull(bare.file)
    }

    @Test
    fun `without a trusted time RECALL ads still play, uncounted, until the time comes`() {
        val time = Time(null, stopAt = 120_000)
        // RECALL's ads are known from a plan seen before.
        val screen = Screen()
        val played = mutableListOf<Played>()
        val (c, playout) = conductor(time, screen, played = played)
        playout.spotAt(h0)
        time.at[40_000] = { time.offset = h0 + 102_000 - 40_000 }
        c.run()
        val shows = screen.shows()
        assertEquals(listOf(0L, 15_000L, 30_000L), shows.take(3).map { it.second })
        assertTrue(shows.take(3).all { !it.third.timed && it.third.shows?.kind == "recall" })
        // The time came at 40 s (UTC h0 + 102 s): at 45 s the spot of now (h0 + 105 s, 2 s in) is
        // joined part-way, then the next starts on its second (h0 + 120 s, at 58 s on the counter).
        assertEquals(45_000L, shows[3].second)
        assertTrue(shows[3].third.timed)
        assertEquals(58_000L, shows[4].second)
        assertEquals(h0 + 120_000, shows[4].third.startUtc)
        assertEquals(false, played[3].whole)
        assertEquals(true, played[4].whole)
    }

    @Test
    fun `clock corrections - a big jump joins the spot of now, a small one waits for the second`() {
        val time = Time(h0, stopAt = 120_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        time.at[20_000] = { time.offset = time.offset!! + 120_000 } // two minutes ahead
        time.at[50_000] = { time.offset = time.offset!! - 3_000 } // three seconds back
        conductor(time, screen, played = played).first.run()
        val shows = screen.shows()
        // At 30 s the next spot (UTC h0+30 s) had long ended by the corrected time: joined h0+150 s.
        val jumped = shows.first { it.second == 30_000L }.third
        assertEquals(h0 + 150_000, jumped.startUtc)
        // After the 3 s step back, the spot starts on its own second: 3 s later on the counter.
        val after = shows.map { it.second }.filter { it > 50_000 }
        assertEquals(63_000L, after.first())
        assertTrue(played.filter { it.spot.startUtc != null && it.spot.startUtc!! > h0 + 150_000 }.all { it.whole })
    }

    @Test
    fun `a spot the screen could not show is not ok, and a bad file goes back to the store`() {
        val time = Time(h0, stopAt = 30_000)
        val screen = object : Renderer {
            lateinit var c: Conductor
            override fun prepare(spot: Spot) {}
            override fun show(spot: Spot) {
                if (spot.shows?.ad == "a2") c.failed(spot, "cannot decode", fileFault = true)
            }
        }
        val played = mutableListOf<Played>()
        val bad = mutableListOf<String>()
        val playout = Playout({ plan to carry }, ::fileOf)
        val c = Conductor(playout, screen, time::utc, { time.mono }, time.waiter, { played += it }, { bad += it })
        screen.c = c
        c.run()
        assertEquals(listOf(true, false), played.map { it.ok })
        assertEquals("cannot decode", played[1].problem)
        assertEquals(listOf("a2"), bad)
    }

    @Test
    fun `no plan for this time - RECALL ads on the grid, nothing planned`() {
        val time = Time(h0 + 3_600_000, stopAt = 30_000)
        val screen = Screen()
        val (c, playout) = conductor(time, screen)
        playout.spotAt(h0)
        c.run()
        val s = screen.shows().first().third
        assertTrue(s.timed)
        assertNull(s.planned)
        assertEquals("recall", s.shows!!.kind)
    }

    @Test
    fun `the next hour starts again at spot 0 of its own plan`() {
        val next = plan.copy(startsAt = hour + 3600, lines = listOf(PlanLine("L2", "paid", listOf("n1"))))
        val time = Time(h0 + 3_600_000 - 30_000, stopAt = 60_000)
        val screen = Screen()
        conductor(time, screen, plans = { t -> if (t < h0 + 3_600_000) plan to carry else next to Carry("L2", null) }).first.run()
        val s = screen.shows().map { it.third }
        assertEquals(listOf(238, 239, 0, 1), s.take(4).map { it.index })
        assertEquals("n1", s[2].shows!!.ad)
    }

    @Test
    fun `the playback thread starts again after anything goes wrong`() {
        val runs = AtomicInteger()
        val t = PlaybackThread({ System.nanoTime() / 1_000_000 }, { w ->
            runs.incrementAndGet()
            val playout = Playout({ null }, { null })
            Conductor(playout, object : Renderer {
                override fun prepare(spot: Spot) {}
                override fun show(spot: Spot) = throw IllegalStateException("screen fell over")
            }, { null }, { System.nanoTime() / 1_000_000 }, w)
        })
        t.start()
        val end = System.currentTimeMillis() + 5_000
        while (runs.get() < 2 && System.currentTimeMillis() < end) Thread.sleep(20)
        t.stop()
        assertTrue(runs.get() >= 2, "started ${runs.get()} times")
    }
}
