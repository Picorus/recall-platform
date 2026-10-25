package app.recall.player.core

import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.boolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/** The same shared cases the cloud's TypeScript passes (packages/domain/test-vectors). */
class ScreenIdentityTest {
    private val v = Json.parseToJsonElement(
        File(System.getProperty("recall.vectors"), "screen-identity.json").readText(),
    ).jsonObject

    private fun str(e: kotlinx.serialization.json.JsonElement): String? =
        if (e is JsonNull) null else e.jsonPrimitive.content

    @Test
    fun `ids, checks, QR texts and number plates match the cloud`() {
        for (x in v["ids"]!!.jsonArray) {
            val o = x.jsonObject
            val random = o["random"]!!.jsonArray.map { it.jsonPrimitive.int }
            assertEquals(o["id"]!!.jsonPrimitive.content, ScreenIdentity.newScreenId(random))
        }
        val c = v["checkCharacterOf"]!!.jsonObject
        assertEquals(c["check"]!!.jsonPrimitive.content[0], ScreenIdentity.checkCharacter(c["body"]!!.jsonPrimitive.content))
        for (x in v["checks"]!!.jsonArray) {
            val o = x.jsonObject
            val text = o["text"]!!.jsonPrimitive.content
            assertEquals(o["valid"]!!.jsonPrimitive.boolean, ScreenIdentity.isScreenId(text), text)
        }
        for (x in v["qrs"]!!.jsonArray) {
            val o = x.jsonObject
            assertEquals(str(o["screenId"]!!), ScreenIdentity.screenIdFromQr(o["text"]!!.jsonPrimitive.content))
        }
        for (x in v["plates"]!!.jsonArray) {
            val o = x.jsonObject
            val text = o["text"]!!.jsonPrimitive.content
            assertEquals(str(o["plate"]!!), ScreenIdentity.numberPlate(text), text)
        }
    }

    @Test
    fun `enrolment bytes match the cloud, and both signatures check`() {
        val e = v["enrolment"]!!.jsonObject
        val r = e["request"]!!.jsonObject
        val req = EnrolmentRequest(
            hardwareSerial = r["hardwareSerial"]!!.jsonPrimitive.content,
            model = r["model"]!!.jsonPrimitive.content,
            tlsPublicKey = r["tlsPublicKey"]!!.jsonPrimitive.content,
            playPublicKey = r["playPublicKey"]!!.jsonPrimitive.content,
            madeAt = r["madeAt"]!!.jsonPrimitive.long,
        )
        assertEquals(e["bytes"]!!.jsonPrimitive.content, req.bytes())

        val signed = Enrolment.request(SoftwareKeyVault(), "RK3566-0A1B2C3D", "VendorX LED28 v1", 1_822_278_600)
        assertNotEquals(signed.request.tlsPublicKey, signed.request.playPublicKey)
        val bytes = signed.request.bytes().toByteArray()
        for ((key, sig) in listOf(
            signed.request.tlsPublicKey to signed.tlsSignature,
            signed.request.playPublicKey to signed.playSignature,
        )) {
            val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(key)))
            val s = Signature.getInstance("SHA256withECDSA")
            s.initVerify(pub)
            s.update(bytes)
            assertTrue(s.verify(Base64.getDecoder().decode(sig)))
        }
    }

    @Test
    fun `the request kept in the shared cases still checks (the cloud checks it too)`() {
        val k = v["kotlinSigned"]!!.jsonObject
        val r = k["request"]!!.jsonObject
        val req = EnrolmentRequest(
            r["hardwareSerial"]!!.jsonPrimitive.content,
            r["model"]!!.jsonPrimitive.content,
            r["tlsPublicKey"]!!.jsonPrimitive.content,
            r["playPublicKey"]!!.jsonPrimitive.content,
            r["madeAt"]!!.jsonPrimitive.long,
        )
        for ((key, sig) in listOf(req.tlsPublicKey to k["tlsSignature"]!!, req.playPublicKey to k["playSignature"]!!)) {
            val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(key)))
            val s = Signature.getInstance("SHA256withECDSA")
            s.initVerify(pub)
            s.update(req.bytes().toByteArray())
            assertTrue(s.verify(Base64.getDecoder().decode(sig.jsonPrimitive.content)))
        }
    }

    @Test
    fun `one wrong character anywhere in an id is always caught`() {
        val alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        val rnd = java.util.Random(7)
        repeat(2_000) {
            val id = ScreenIdentity.newScreenId(List(7) { rnd.nextInt(32) })
            val at = 4 + rnd.nextInt(8)
            val c = alphabet[(alphabet.indexOf(id[at]) + 1 + rnd.nextInt(31)) % 32]
            assertEquals(false, ScreenIdentity.isScreenId(id.substring(0, at) + c + id.substring(at + 1)))
        }
    }
}
