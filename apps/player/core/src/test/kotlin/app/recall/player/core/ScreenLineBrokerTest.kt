package app.recall.player.core

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.math.BigInteger
import java.net.InetSocketAddress
import java.net.Socket
import java.nio.file.Files
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.ExtendedKeyUsage
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.asn1.x509.KeyPurposeId
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.openssl.jcajce.JcaPEMWriter
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The box's line against a real EMQX broker (Docker) with RECALL's production settings
 * (infra/emqx/emqx.conf.template): TLS with the box's own key and certificate, hello and time, uploads
 * acked, and the line coming back by itself after the broker restarts. A stand-in cloud answers like
 * the gateway (the real gateway is proven in services/gateway/test/emqx). Runs when
 * RECALL_BROKER_TEST=1 (CI; needs Docker).
 */
class ScreenLineBrokerTest {
    private val enabled = System.getenv("RECALL_BROKER_TEST") == "1"
    private val name = "recall-line-test-${System.nanoTime()}"
    private val sslPort = 38883
    private val tcpPort = 31883
    private val me = "SCR-0123456Z"
    private val cleanups = mutableListOf<() -> Unit>()

    @AfterTest
    fun cleanUp() = cleanups.reversed().forEach { runCatching(it) }

    /** On a failure, what the broker said (the test output keeps it). */
    private fun <T> explained(body: () -> T): T = try {
        body()
    } catch (e: Throwable) {
        println(runCatching { docker("logs", "--tail", "60", name) }.getOrDefault("(no broker log)"))
        throw e
    }

    private fun keys(): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    private fun cert(
        subject: String,
        key: PublicKey,
        issuer: String,
        signer: PrivateKey,
        ca: Boolean,
        server: Boolean = false,
    ): X509Certificate {
        val now = System.currentTimeMillis()
        val b = JcaX509v3CertificateBuilder(
            X500Name(issuer), BigInteger.valueOf(now), Date(now - 3_600_000), Date(now + 86_400_000), X500Name(subject), key,
        )
        b.addExtension(Extension.basicConstraints, true, BasicConstraints(ca))
        if (!ca) {
            b.addExtension(
                Extension.extendedKeyUsage, false,
                ExtendedKeyUsage(if (server) KeyPurposeId.id_kp_serverAuth else KeyPurposeId.id_kp_clientAuth),
            )
        }
        if (server) {
            b.addExtension(
                Extension.subjectAlternativeName, false,
                GeneralNames(arrayOf(GeneralName(GeneralName.dNSName, "localhost"), GeneralName(GeneralName.iPAddress, "127.0.0.1"))),
            )
        }
        return JcaX509CertificateConverter().getCertificate(b.build(JcaContentSignerBuilder("SHA256withECDSA").build(signer)))
    }

    private fun pem(o: Any): String = java.io.StringWriter().also { w -> JcaPEMWriter(w).use { it.writeObject(o) } }.toString()

    private fun portOpen(port: Int) = runCatching { Socket("127.0.0.1", port).close() }.isSuccess

    private fun docker(vararg args: String): String {
        val p = ProcessBuilder("docker", *args).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor() == 0) { "docker ${args.first()}: $out" }
        return out
    }

    private fun until(what: String, ms: Long, ok: () -> Boolean) {
        val end = System.currentTimeMillis() + ms
        while (!ok()) {
            check(System.currentTimeMillis() < end) { "timed out waiting for: $what\n" + runCatching { docker("logs", "--tail", "40", name) }.getOrDefault("") }
            Thread.sleep(200)
        }
    }

    @Test
    fun `the box's line over TLS to a real broker - hello, time, uploads acked, back by itself after a restart`() {
        if (!enabled) return
        explained { run() }
    }

    private fun run() {
        // Our screen authority and the box's certificate, made for the box's own key (P2.1).
        val vault = SoftwareKeyVault()
        vault.publicKey(Enrolment.TLS_KEY)
        val boxKey = vault.privateKey(Enrolment.TLS_KEY)
        val boxPublic = java.security.KeyFactory.getInstance("EC").generatePublic(
            java.security.spec.X509EncodedKeySpec(java.util.Base64.getDecoder().decode(vault.publicKey(Enrolment.TLS_KEY))),
        )
        val screensCa = keys()
        val screensCaCert = cert("CN=RECALL screens test", screensCa.public, "CN=RECALL screens test", screensCa.private, ca = true)
        val boxCert = cert("CN=$me", boxPublic, "CN=RECALL screens test", screensCa.private, ca = false)
        // The broker's own certificate, from another authority the box trusts.
        val brokerCa = keys()
        val brokerCaCert = cert("CN=RECALL broker test", brokerCa.public, "CN=RECALL broker test", brokerCa.private, ca = true)
        val brokerKey = keys()
        val brokerCert = cert("CN=localhost", brokerKey.public, "CN=RECALL broker test", brokerCa.private, ca = false, server = true)

        // The gateway's hooks, standing in: everyone in, the stand-in cloud as superuser.
        val hooks = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        hooks.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().decodeToString()
            val cloud = body.contains("\"username\":\"recall-gateway\"")
            val reply = """{"result":"allow","is_superuser":$cloud}""".toByteArray()
            ex.responseHeaders.add("content-type", "application/json")
            ex.sendResponseHeaders(200, reply.size.toLong())
            ex.responseBody.use { it.write(reply) }
        }
        hooks.start()
        cleanups += { hooks.stop(0) }

        val dir = Files.createTempDirectory("recall-line").toFile()
        File(dir, "screens-ca.pem").writeText(pem(screensCaCert))
        File(dir, "server.pem").writeText(pem(brokerCert))
        File(dir, "server.key").writeText(pem(org.bouncycastle.openssl.jcajce.JcaPKCS8Generator(brokerKey.private, null)))
        val conf = File(System.getProperty("recall.emqxTemplate")).readText()
            .replace("{{SSL_PORT}}", "$sslPort")
            .replace("{{TCP_BIND}}", "127.0.0.1:$tcpPort")
            .replace("{{CERT_DIR}}", "/certs")
            .replace("{{HOOK_URL}}", "http://127.0.0.1:${hooks.address.port}")
            .replace("{{HOOK_TOKEN}}", "t".repeat(32))
            .replace("{{NODE_COOKIE}}", "c".repeat(32))
        File(dir, "emqx.conf").writeText(conf)
        dir.listFiles()!!.forEach { it.setReadable(true, false) }
        dir.setReadable(true, false)
        dir.setExecutable(true, false)
        docker(
            "run", "-d", "--name", name, "--network", "host",
            "-e", "ERL_FLAGS=-kernel inet_dist_use_interface {127,0,0,1}",
            "-v", "${dir.absolutePath}:/certs:ro", "-v", "${File(dir, "emqx.conf").absolutePath}:/opt/emqx/etc/emqx.conf:ro",
            "emqx/emqx:5.8.6",
        )
        cleanups += { docker("rm", "-f", name) }
        until("the broker", 120_000) { portOpen(sslPort) && portOpen(tcpPort) }

        // The stand-in cloud: answers hellos with the time and acks uploads, like the gateway.
        val uploads = CopyOnWriteArrayList<String>()
        fun cloud(): MqttClient {
            val c = MqttClient("tcp://127.0.0.1:$tcpPort", "recall-gateway-test", MemoryPersistence())
            c.setCallback(object : org.eclipse.paho.client.mqttv3.MqttCallback {
                override fun connectionLost(cause: Throwable?) {}
                override fun deliveryComplete(token: org.eclipse.paho.client.mqttv3.IMqttDeliveryToken?) {}
                override fun messageArrived(topic: String, message: org.eclipse.paho.client.mqttv3.MqttMessage) {
                    val o = Json.parseToJsonElement(String(message.payload)).jsonObject
                    val id = topic.split("/")[3]
                    Thread {
                        if (topic.endsWith("/up/hello")) {
                            c.publish("recall/v1/s/$id/down/time", """{"utcMs":${System.currentTimeMillis()},"echo":${o.getValue("mono").jsonPrimitive.long}}""".toByteArray(), 1, false)
                        } else {
                            uploads += String(message.payload)
                            val top = o.getValue("batch").jsonArray.maxOf { it.jsonObject.getValue("seq").jsonPrimitive.long }
                            c.publish("recall/v1/s/$id/down/ack", """{"ack":$top}""".toByteArray(), 1, false)
                        }
                    }.start()
                }
            })
            // A broker still starting refuses at first (as the real gateway sees): try until it takes us.
            until("the stand-in cloud connected and subscribed", 60_000) {
                runCatching {
                    if (!c.isConnected) {
                        c.connect(MqttConnectOptions().apply {
                            userName = "recall-gateway"
                            password = "p".repeat(32).toCharArray()
                            isCleanSession = true
                        })
                    }
                    val token = c.subscribeWithResponse("\$share/gateway/recall/v1/s/+/up/+", 1)
                    token.waitForCompletion(10_000)
                    check((token.grantedQos.firstOrNull() ?: 0x80) < 0x80)
                }.isSuccess
            }
            return c
        }
        var cloudClient = cloud()
        cleanups += { runCatching { cloudClient.disconnectForcibly(500, 500) } }

        // The box.
        val outbox = Outbox(Files.createTempDirectory("box").toFile())
        val clock = AtomicReference(TrustedClock())
        val mono = { System.nanoTime() / 1_000_000 }
        val now = System.currentTimeMillis() / 1000
        (1..5).forEach { outbox.add(JsonObject(mapOf("kind" to JsonPrimitive("live"), "n" to JsonPrimitive(it))), now) }
        val factory = LineTls.socketFactory(boxKey, pem(boxCert), pem(brokerCaCert))
        val line = ScreenLine(
            me, "0.3.0", outbox, { PahoTransport("ssl://localhost:$sslPort", me, factory) }, clock, mono,
            random = { 0 }, rules = LineRules(resendMs = 2_000), backoffRules = BackoffRules(firstMs = 500, longestMs = 2_000),
        )
        line.start()
        cleanups += { line.stop() }

        until("all five reports acked", 60_000) { outbox.waiting() == 0 }
        val cloudTime = clock.get().cloudNow(mono())
        assertNotNull(cloudTime)
        assertTrue(Math.abs(cloudTime - System.currentTimeMillis()) < 5_000)

        // The broker restarts (and the stand-in cloud with it): the box comes back by itself.
        docker("restart", name)
        until("the broker back", 120_000) { portOpen(sslPort) && portOpen(tcpPort) }
        cloudClient = cloud()
        (6..8).forEach { outbox.add(JsonObject(mapOf("kind" to JsonPrimitive("live"), "n" to JsonPrimitive(it))), now) }
        line.nudge()
        until("the new reports acked after the restart", 90_000) { outbox.waiting() == 0 }
        assertTrue(uploads.any { it.contains("\"seq\":8,") })
    }
}
