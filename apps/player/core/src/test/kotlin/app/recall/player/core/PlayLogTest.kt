package app.recall.player.core

import java.io.File
import java.nio.file.Files
import java.security.KeyFactory
import java.security.PublicKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** P2.7: the signed play log, against the cloud's own cases (packages/domain/test-vectors/plays.json). */
class PlayLogTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "plays.json").readText()).jsonObject
    private val dir: File = Files.createTempDirectory("plays").toFile()
    private val screenId = "SCR-0001234K"
    private val t0 = 1_793_628_000_000L // a whole spot, UTC ms

    private fun key(b64: String): PublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(b64)))

    private fun verifies(key: PublicKey, bytes: String, sig: String): Boolean = Signature.getInstance("SHA256withECDSA").run {
        initVerify(key)
        update(bytes.toByteArray(Charsets.UTF_8))
        verify(Base64.getDecoder().decode(sig))
    }

    private fun s(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.content
    private fun l(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.long

    /** The report and the number of the one stored play record in `box`. */
    private fun stored(box: Outbox): List<Pair<Long, JsonObject>> = box.nextBatch().map { q ->
        val o = Json.parseToJsonElement(q.text).jsonObject
        q.seq to o.getValue("report").jsonObject
    }

    private fun spot(start: Long, shows: SpotChoice? = SpotChoice("brand", "BK-0007/hyd-madhapur/2026-11-02/18", "a1")) =
        Spot(start, start + 15_000, "hyd-madhapur", 1, shows, shows, null)

    private fun counted(start: Long, shows: SpotChoice? = SpotChoice("brand", "BK-0007/hyd-madhapur/2026-11-02/18", "a1")) =
        Played(spot(start, shows), whole = true, ok = true, problem = null, counts = true)

    @Test
    fun `the box builds the same report and signs the same bytes as the cloud`() {
        val pub = key(s(v, "publicKey"))
        val cases = v.getValue("cases").jsonArray.map { it.jsonObject }
        assertEquals(4, cases.size)
        for (c in cases) {
            val p = c.getValue("play").jsonObject
            val report = PlayRecord.report(
                slot = s(p, "slot"),
                ref = s(p, "ref"),
                adId = s(p, "adId"),
                startAt = l(p, "startAt"),
                lengthS = l(p, "lengthS"),
                where = Where(l(p, "latE6"), l(p, "lngE6"), l(p, "accuracyM"), s(p, "place")),
                people = l(p, "people"),
                keyId = s(p, "keyId"),
            )
            assertEquals(p, report, s(c, "name"))
            val bytes = PlayRecord.bytes(s(c, "screenId"), l(c, "seq"), report)
            assertEquals(s(c, "bytes"), bytes, s(c, "name"))
            // The cloud's own signature over the bytes the box builds: the same check the cloud makes.
            assertTrue(verifies(pub, bytes, s(c, "sig")), s(c, "name"))
        }
    }

    @Test
    fun `a play is signed for its own number, and signed again when renumbered`() {
        val vault = SoftwareKeyVault()
        val pub = key(vault.publicKey(Enrolment.PLAY_KEY))
        val signer = PlaySigner(screenId, vault)
        val box = Outbox(File(dir, "outbox"), seal = signer::seal)
        val play = PlayRecord.report("brand", "BK-0007/hyd-madhapur/2026-11-02/18", "a1", 1_793_628_015, 15, Where.unknown("inside:hyd-madhapur@3"))
        val live = JsonObject(mapOf("kind" to JsonPrimitive("live"), "n" to JsonPrimitive(1)))
        box.add(play, 1_793_628_015)
        box.add(live, 1_793_628_016)
        val (seq, r) = stored(box).first()
        assertEquals(1L, seq)
        assertTrue(verifies(pub, PlayRecord.bytes(screenId, 1, r), s(r, "sig")))
        assertFalse(verifies(pub, PlayRecord.bytes(screenId, 2, r), s(r, "sig")), "not for another number")
        assertFalse(verifies(pub, PlayRecord.bytes("SCR-0000001A", 1, r), s(r, "sig")), "not for another screen")
        assertEquals(live, stored(box)[1].second, "other reports pass unchanged")

        // The box's numbering started again: the cloud already has numbers up to 900.
        assertEquals(2, box.renumberAfter(900))
        val (seq2, r2) = stored(box).first()
        assertEquals(901L, seq2)
        assertTrue(verifies(pub, PlayRecord.bytes(screenId, 901, r2), s(r2, "sig")))
        assertEquals(JsonObject(r - "sig"), JsonObject(r2 - "sig"), "the same play")
    }

    @Test
    fun `only counted plays are recorded, with where the bike was at the start`() {
        val vault = SoftwareKeyVault()
        val box = Outbox(File(dir, "outbox"), seal = PlaySigner(screenId, vault)::seal)
        val markFile = MarkFile(File(dir, "plays/mark"))
        var nudged = 0
        val asked = mutableListOf<Long>()
        val log = PlayLog(box, { t ->
            asked += t
            Where(17_447_512, 78_391_044, 8, "inside:hyd-madhapur@3")
        }, markFile, stored = { nudged++ })
        log.record(Played(spot(t0), whole = false, ok = true, problem = null, counts = false))
        log.record(Played(spot(t0 + 15_000, null), whole = true, ok = true, problem = null, counts = false))
        log.record(counted(t0 + 30_000))
        log.record(counted(t0 + 45_000, SpotChoice("recall", null, "r1")))
        log.record(counted(t0 + 60_000, SpotChoice("make-up", "BK-0003/hyd-madhapur/2026-11-01/20#1", "m1")))
        log.flush()
        assertEquals(3L, log.recorded)
        assertEquals(0L, log.failed)
        assertEquals(3, nudged)
        assertEquals(listOf(t0 / 1000 + 30, t0 / 1000 + 45, t0 / 1000 + 60), asked, "where at each play's first second")
        val rs = stored(box).map { it.second }
        assertEquals(listOf("brand", "recall", "make-up"), rs.map { s(it, "slot") })
        assertEquals(listOf("BK-0007/hyd-madhapur/2026-11-02/18", "", "BK-0003/hyd-madhapur/2026-11-01/20#1"), rs.map { s(it, "ref") })
        assertEquals(listOf("a1", "r1", "m1"), rs.map { s(it, "adId") })
        assertEquals(t0 / 1000 + 30, l(rs[0], "startAt"))
        assertEquals(15L, l(rs[0], "lengthS"))
        assertEquals(17_447_512L, l(rs[0], "latE6"))
        assertEquals(8L, l(rs[0], "accuracyM"))
        assertEquals("inside:hyd-madhapur@3", s(rs[0], "place"))
        assertEquals(0L, l(rs[0], "people"), "people are an estimate, never billed: none until P2.9")
        assertEquals(t0 + 60_000, markFile.load(), "the latest spot counted is on storage")
    }

    @Test
    fun `a record that cannot be stored is counted, and the next one still is`() {
        var broken = true
        val box = Outbox(File(dir, "outbox"), seal = { _, r -> if (broken) error("keystore busy") else r })
        val logged = mutableListOf<String>()
        val log = PlayLog(box, { null }, MarkFile(File(dir, "mark")), log = { logged += it }, pause = {})
        log.record(counted(t0))
        log.flush()
        broken = false
        log.record(counted(t0 + 15_000))
        log.flush()
        assertEquals(1L, log.failed)
        assertEquals(1L, log.recorded)
        assertTrue(logged.single().contains("keystore busy"))
        val r = stored(box).single().second
        // No position known: the cloud keeps the play but cannot count it.
        assertEquals(Where.NO_FIX_ACCURACY_M, l(r, "accuracyM"))
        assertEquals("outside", s(r, "place"))
    }

    @Test
    fun `a busy keystore is tried again, and the mark is on storage before the record`() {
        val markFile = MarkFile(File(dir, "mark"))
        var tries = 0
        val waits = mutableListOf<Long>()
        val box = Outbox(File(dir, "outbox"), seal = { _, r ->
            tries++
            assertEquals(t0, markFile.load(), "the mark is saved first")
            if (tries < 3) error("keystore busy") else r
        })
        val log = PlayLog(box, { null }, markFile, pause = { waits += it })
        log.record(counted(t0))
        log.flush()
        assertEquals(1L, log.recorded)
        assertEquals(0L, log.failed)
        assertEquals(listOf(200L, 1_000L), waits)
    }

    @Test
    fun `renumbering changes nothing when a play cannot be signed, and works when it can`() {
        var broken = false
        val box = Outbox(File(dir, "outbox"), seal = { seq, r ->
            if (broken && seq > 900) error("keystore busy") else JsonObject(r + ("n" to JsonPrimitive(seq)))
        })
        repeat(3) { box.add(PlayRecord.report("recall", "", "r1", 1_793_628_015L + 15 * it, 15, Where.unknown()), 1_793_628_015L + 15 * it) }
        broken = true
        assertTrue(runCatching { box.renumberAfter(900) }.isFailure)
        assertEquals(listOf(1L, 2L, 3L), box.nextBatch().map { it.seq }, "nothing renumbered, nothing lost")
        assertEquals(3L, box.lastNumber())
        broken = false
        assertEquals(3, box.renumberAfter(900))
        assertEquals(listOf(901L, 902L, 903L), stored(box).map { l(it.second, "n") })
        assertEquals(listOf(901L, 902L, 903L), box.nextBatch().map { it.seq })
    }

    @Test
    fun `a mark from a wrong clock is brought back to the cloud's time`() {
        val mark = PlayedMark(t0 + 5L * 365 * 24 * 3_600_000) // a faked GPS date, years ahead
        assertFalse(mark.claim(t0), "it would block every real play")
        assertFalse(PlayedMark(t0 + 30_000).pullBack(t0), "a little ahead is left alone")
        assertTrue(mark.pullBack(t0))
        assertFalse(mark.claim(t0), "never the spot of the cloud's time itself again")
        assertTrue(mark.claim(t0 + 15_000))
    }

    @Test
    fun `a play the cloud would refuse is never signed`() {
        val log = PlayLog(Outbox(File(dir, "outbox")), { null }, MarkFile(File(dir, "mark")))
        log.record(counted(t0, SpotChoice("brand", "BK-1/x\ny", "a1")))
        log.record(counted(t0 + 15_000, SpotChoice("brand", null, "a1")))
        log.flush()
        assertEquals(2L, log.failed)
        assertEquals(0L, log.recorded)
    }

    @Test
    fun `the mark survives a restart`() {
        val f = MarkFile(File(dir, "plays/mark"))
        assertEquals(Long.MIN_VALUE, f.load())
        f.save(t0)
        val mark = PlayedMark(MarkFile(File(dir, "plays/mark")).load())
        assertFalse(mark.claim(t0), "a spot counted before the restart is never counted again")
        assertTrue(mark.claim(t0 + 15_000))
    }

    @Test
    fun `the scheduler remembers where the bike was each second`() {
        val s = LocalScheduler(File(dir, "schedule"), screenId)
        val area = Place.Inside("hyd-madhapur", 3)
        val t = t0 / 1000
        s.onSecond(Second(t, FixVerdict.USED, LatLng(17.4475124, 78.3910436), area, true, false, true, accuracyM = 7.2))
        s.onSecond(Second(t + 1, FixVerdict.NO_FIX, null, area, true, false, true))
        assertEquals(Where(17_447_512, 78_391_044, 8, "inside:hyd-madhapur@3"), s.where(t))
        assertEquals(Where(17_447_512, 78_391_044, 8, "inside:hyd-madhapur@3"), s.where(t + 1), "no fix that second: the nearest one")
        assertEquals(Where(17_447_512, 78_391_044, 8, "inside:hyd-madhapur@3"), s.where(t + 5), "within 5 seconds")
        assertEquals(Where.unknown("inside:hyd-madhapur@3"), s.where(t + 6), "further: no position")
        s.onSecond(Second(t + 3, FixVerdict.USED, LatLng(17.45, 78.39), area, true, false, true, accuracyM = 4.0))
        assertEquals(17_450_000L, s.where(t + 4).latE6, "the closest fix wins")
        assertEquals(17_447_512L, s.where(t + 1).latE6)
        s.onSecond(Second(t + 200, FixVerdict.NO_FIX, null, Place.Outside, true, false, true))
        assertEquals(Where.unknown("outside"), s.where(t), "old seconds are let go")
        assertNull(Where.of(LatLng(1.0, 2.0), Double.NaN, Place.Outside).takeIf { it.accuracyM != Where.NO_FIX_ACCURACY_M })
    }
}
