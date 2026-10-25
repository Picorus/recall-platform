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

    /** A screen that shows whatever it is given and confirms it, unless told otherwise. */
    inner class Screen : Renderer {
        val events = CopyOnWriteArrayList<Triple<String, Long, Spot>>()
        lateinit var time: Time
        lateinit var c: Conductor
        var confirm = true
        var onPrepare: (Spot) -> Unit = {}
        var onShow: (Spot) -> Unit = {}
        override fun prepare(spot: Spot) {
            events += Triple("prepare", time.mono, spot)
            onPrepare(spot)
        }
        override fun show(spot: Spot) {
            events += Triple("show", time.mono, spot)
            if (confirm) c.started(spot)
            onShow(spot)
        }
        fun shows() = events.filter { it.first == "show" }
    }

    private fun conductor(
        time: Time,
        screen: Screen,
        plans: PlanSource = PlanSource { t -> (plan to carry).takeIf { t >= h0 && t < h0 + 3_600_000 } },
        played: MutableList<Played> = mutableListOf(),
        bad: MutableList<String> = mutableListOf(),
        utc: (Long) -> Long? = time::utc,
        mark: PlayedMark = PlayedMark(),
        covered: (Long) -> String? = { null },
    ): Pair<Conductor, Playout> {
        screen.time = time
        val playout = Playout(plans, ::fileOf)
        val c = Conductor(playout, screen, utc, { time.mono }, time.waiter, { played += it }, { bad += it }, mark = mark, covered = covered)
        screen.c = c
        return c to playout
    }

    @Test
    fun `a whole hour on the second - 200 brand plays, 40 RECALL spots, ads in turn, each loaded ahead`() {
        // Stopped just after the hour's last spot ended.
        val time = Time(h0, stopAt = 3_600_001)
        val screen = Screen()
        val all = mutableListOf<Played>()
        conductor(time, screen, played = all).first.run()
        val shows = screen.shows().take(240)
        val played = all.take(240)
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
        assertTrue(played.all { it.whole && it.ok && it.spot.timed && it.counts })
    }

    @Test
    fun `starting part-way through a spot joins it but never counts it, then keeps to the second`() {
        val time = Time(h0 + 4_000, stopAt = 60_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        conductor(time, screen, played = played).first.run()
        val shows = screen.shows()
        assertEquals(listOf(0L, 11_000L, 26_000L, 41_000L, 56_000L), shows.map { it.second })
        assertEquals(listOf(false, true, true, true, false), played.map { it.whole }, "the last one was stopped part-way")
        assertEquals(listOf(false, true, true, true, false), played.map { it.counts })
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
        // After the 3 s step back: RECALL filler at 60 s (never counted), then the spot on its own
        // second, 3 s later on the counter.
        val after = shows.filter { it.second > 50_000 }
        assertEquals(60_000L, after[0].second)
        assertEquals(null, after[0].third.startUtc)
        assertEquals(63_000L, after[1].second)
        // Every spot after the jump is whole again (the last one aside: the test stops part-way).
        assertTrue(played.dropLast(1).filter { it.spot.startUtc != null && it.spot.startUtc!! > h0 + 150_000 }.all { it.whole })
    }

    @Test
    fun `a spot the screen could not show, or never confirmed, does not count, and a bad file goes back`() {
        val time = Time(h0, stopAt = 60_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        val bad = mutableListOf<String>()
        conductor(time, screen, played = played, bad = bad)
        screen.onShow = { if (it.shows?.ad == "a2") screen.c.failed(it, "cannot decode", fileFault = true) }
        // A problem found while loading, before the spot is on screen, still counts against it.
        screen.onPrepare = { if (it.shows?.ad == "a3") screen.c.failed(it, "cannot open", fileFault = false) }
        screen.c.run()
        assertEquals(listOf(true, false, false, true), played.map { it.ok })
        assertEquals(listOf("cannot decode", "cannot open"), played.mapNotNull { it.problem }.take(2))
        assertEquals(listOf("a2"), bad)
        assertEquals(listOf(true, false, false, false), played.map { it.counts }, "the last was stopped part-way")

        val quiet = Screen().apply { confirm = false }
        val none = mutableListOf<Played>()
        conductor(Time(h0, stopAt = 30_000), quiet, played = none).first.run()
        assertTrue(none.none { it.ok || it.counts }, "no confirmation from the screen, no play")
    }

    @Test
    fun `a spot covered by a blank for any part of it never counts, even one already showing`() {
        val time = Time(h0, stopAt = 60_001)
        var on = false
        var ended = Long.MIN_VALUE
        time.at[20_000L] = { on = true } // a blank arrives mid-spot (spot 1 is 15–30 s)
        time.at[25_000L] = { on = false; ended = 25_000L }
        val played = mutableListOf<Played>()
        conductor(time, Screen(), played = played, covered = { since -> if (on || ended >= since) "blanked by a command" else null }).first.run()
        assertEquals(listOf(true, false, true, true), played.take(4).map { it.counts })
        assertEquals("blanked by a command", played[1].problem)
    }

    @Test
    fun `a clock moved back by more than a spot never counts the same spot twice, even after a restart`() {
        val time = Time(h0, stopAt = 150_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        val mark = PlayedMark()
        time.at[46_000] = { time.offset = time.offset!! - 40_000 }
        conductor(time, screen, played = played, mark = mark).first.run()
        val counted = played.filter { it.counts }.map { it.spot.startUtc!! }
        assertEquals(counted.distinct(), counted, "a spot counted twice")
        assertEquals(counted.sorted(), counted)
        assertTrue(played.any { !it.counts && it.whole && it.spot.timed }, "the repeats were shown but not counted")
        // A fresh conductor (the playback thread restarted) with the same mark counts none of them again.
        val again = mutableListOf<Played>()
        val t2 = Time(h0, stopAt = 60_000)
        conductor(t2, Screen(), played = again, mark = mark).first.run()
        assertTrue(again.none { it.counts })
    }

    @Test
    fun `a long wait for a spot second shows RECALL filler, never counted`() {
        val time = Time(h0, stopAt = 60_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        time.at[20_000] = { time.offset = time.offset!! - 8_000 } // eight seconds back
        conductor(time, screen, played = played).first.run()
        val filler = played.first { !it.spot.timed }
        assertEquals("recall", filler.spot.shows!!.kind)
        assertTrue(!filler.counts)
        // The spot after it starts on its own second: 30 s + 8 s on the counter.
        assertTrue(screen.shows().any { it.second == 38_000L && it.third.startUtc == h0 + 30_000 })
    }

    @Test
    fun `the trusted time going away between two reads, or for good, never crashes playback`() {
        val time = Time(h0, stopAt = 90_000)
        val screen = Screen()
        val played = mutableListOf<Played>()
        var reads = 0
        // Every third read finds no time (a newer sample replaced the only one), and from 40 s none.
        val flaky: (Long) -> Long? = { m -> reads++; if (reads % 3 == 0 || m >= 40_000) null else time.utc(m) }
        conductor(time, screen, played = played, utc = flaky).first.run()
        assertTrue(screen.shows().size >= 6)
        assertTrue(played.filter { it.counts }.all { it.spot.startUtc!! < h0 + 40_000 })
        assertTrue(played.last().spot.startUtc == null, "after the time went: RECALL ads, untimed")
    }

    @Test
    fun `a plan that cannot be read, or is off the grid, is no plan - RECALL ads keep playing`() {
        val time = Time(h0, stopAt = 30_000)
        val screen = Screen()
        val (c, playout) = conductor(time, screen, plans = { t -> if (t < h0 + 15_000) plan to carry else error("plan broken") })
        playout.spotAt(h0)
        c.run()
        assertEquals("recall", screen.shows()[1].third.shows!!.kind)
        val off = Playout({ plan.copy(startsAt = hour + 7) to carry }, ::fileOf)
        assertNull(off.spotAt(h0 + 30_000).planned)
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
        val t = PlaybackThread({ System.nanoTime() / 1_000_000 }, { w, mark ->
            runs.incrementAndGet()
            val playout = Playout({ null }, { null })
            Conductor(playout, object : Renderer {
                override fun prepare(spot: Spot) {}
                override fun show(spot: Spot) = throw IllegalStateException("screen fell over")
            }, { null }, { System.nanoTime() / 1_000_000 }, w, mark = mark)
        })
        t.start()
        val end = System.currentTimeMillis() + 5_000
        while (runs.get() < 2 && System.currentTimeMillis() < end) Thread.sleep(20)
        t.stop()
        assertTrue(runs.get() >= 2, "started ${runs.get()} times")
    }
}
