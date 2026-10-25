package app.recall.player.core

import com.sun.net.httpserver.HttpsConfigurator
import com.sun.net.httpserver.HttpsServer
import java.io.IOException
import java.math.BigInteger
import java.net.InetSocketAddress
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.cert.jcajce.JcaX509CertificateConverter
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder

/** Real HTTPS downloads from a local server standing in for storage. */
class HttpsFetcherTest {
    private val file = Random(1).nextBytes(100_000)
    private val ranges = mutableListOf<String?>()
    private val keys = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val cert = run {
        val now = System.currentTimeMillis()
        val b = JcaX509v3CertificateBuilder(
            X500Name("CN=localhost"), BigInteger.ONE, Date(now - 3_600_000), Date(now + 86_400_000), X500Name("CN=localhost"), keys.public,
        )
        b.addExtension(Extension.subjectAlternativeName, false, GeneralNames(GeneralName(GeneralName.dNSName, "localhost")))
        JcaX509CertificateConverter().getCertificate(b.build(JcaContentSignerBuilder("SHA256withECDSA").build(keys.private)))
    }
    private val server = HttpsServer.create(InetSocketAddress("localhost", 0), 0).apply {
        val ks = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setKeyEntry("s", keys.private, CharArray(0), arrayOf(cert))
        }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(ks, CharArray(0)) }
        httpsConfigurator = HttpsConfigurator(SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) })
        createContext("/ad") { x ->
            val range = x.requestHeaders.getFirst("Range")
            ranges += range
            val from = range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
            if (x.requestURI.query == "norange" || from == 0) {
                x.sendResponseHeaders(200, file.size.toLong())
                x.responseBody.use { it.write(file) }
            } else {
                x.responseHeaders.add("Content-Range", "bytes $from-${file.size - 1}/${file.size}")
                x.sendResponseHeaders(206, (file.size - from).toLong())
                x.responseBody.use { it.write(file, from, file.size - from) }
            }
        }
        createContext("/gone") { x -> x.sendResponseHeaders(403, -1); x.close() }
        createContext("/plain") { x ->
            x.responseHeaders.add("Location", "http://localhost:${address.port}/ad")
            x.sendResponseHeaders(302, -1)
            x.close()
        }
        start()
    }
    private val tls = SSLContext.getInstance("TLS").apply {
        val ts = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setCertificateEntry("storage", cert)
        }
        init(null, TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ts) }.trustManagers, null)
    }.socketFactory
    private val base = "https://localhost:${server.address.port}"

    @AfterTest
    fun stop() = server.stop(0)

    @Test
    fun `downloads a whole file, and carries on from a byte with a range request`() {
        val f = HttpsFetcher(tls)
        f.fetch("$base/ad", 0).use {
            assertEquals(0L, it.startsAt)
            assertContentEquals(file, it.body.readBytes())
        }
        f.fetch("$base/ad", 60_000).use {
            assertEquals(60_000L, it.startsAt)
            assertContentEquals(file.copyOfRange(60_000, file.size), it.body.readBytes())
        }
        assertEquals(listOf(null, "bytes=60000-"), ranges)
    }

    @Test
    fun `a server that ignores the range sends the whole file from the start`() {
        HttpsFetcher(tls).fetch("$base/ad?norange", 60_000).use {
            assertEquals(0L, it.startsAt)
            assertContentEquals(file, it.body.readBytes())
        }
    }

    @Test
    fun `refuses plain HTTP, an unknown certificate, a redirect to HTTP and an error`() {
        assertFailsWith<IOException> { HttpsFetcher(tls).fetch("http://localhost:${server.address.port}/ad", 0) }
        assertFailsWith<IOException> { HttpsFetcher().fetch("$base/ad", 0) }
        assertFailsWith<IOException> { HttpsFetcher(tls).fetch("$base/plain", 0) }
        assertFailsWith<IOException> { HttpsFetcher(tls).fetch("$base/gone", 0) }
    }

    @Test
    fun `end to end through the store`() {
        val dir = kotlin.io.path.createTempDirectory("ads").toFile()
        val s = AdStore(dir)
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(file).joinToString("") { "%02x".format(it) }
        s.want(1, listOf(AdFile("A", sha, file.size.toLong(), "$base/ad", 1_790_000_000L)))
        assertEquals(1, s.fetchMissing(HttpsFetcher(tls), null, 0))
        assertContentEquals(file, s.file("A")!!.readBytes())
    }
}
