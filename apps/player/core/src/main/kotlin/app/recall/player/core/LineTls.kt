// P2.3.3: the box's side of the secure line's handshake. The box shows the certificate our warehouse
// gave it (P2.1) and proves it holds the key, which never leaves its secure store: the handshake asks
// the store to sign. It trusts only RECALL's broker certificate authority, not the phone's list of
// public ones, so a look-alike server cannot pose as the cloud.
package app.recall.player.core

import java.net.Socket
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager

object LineTls {
    private const val ALIAS = "recall-box"

    fun certificate(pem: String): X509Certificate =
        CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate

    /**
     * A socket factory for the line: the box's key and certificate on our side, only `brokerCaPem`
     * trusted on the broker's side, TLS 1.2 or 1.3.
     */
    fun socketFactory(key: PrivateKey, certPem: String, brokerCaPem: String): SSLSocketFactory {
        val cert = certificate(certPem)
        val keys = object : X509ExtendedKeyManager() {
            override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(ALIAS)
            override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = ALIAS
            override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = ALIAS
            override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
            override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
            override fun getCertificateChain(alias: String?) = arrayOf(cert)
            override fun getPrivateKey(alias: String?) = key
        }
        val trusted = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("recall-broker-ca", certificate(brokerCaPem))
        }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(trusted) }
        val context = SSLContext.getInstance("TLS").apply { init(arrayOf(keys), trust.trustManagers, null) }
        return OnlyModernTls(context.socketFactory)
    }

    /** Wraps a factory so every socket speaks TLS 1.2 or 1.3 only. */
    private class OnlyModernTls(private val inner: SSLSocketFactory) : SSLSocketFactory() {
        private fun strict(s: Socket): Socket = s.also {
            if (it is javax.net.ssl.SSLSocket) {
                it.enabledProtocols = it.supportedProtocols.filter { p -> p == "TLSv1.3" || p == "TLSv1.2" }.toTypedArray()
            }
        }
        override fun getDefaultCipherSuites(): Array<String> = inner.defaultCipherSuites
        override fun getSupportedCipherSuites(): Array<String> = inner.supportedCipherSuites
        override fun createSocket(s: Socket?, host: String?, port: Int, autoClose: Boolean) = strict(inner.createSocket(s, host, port, autoClose))
        override fun createSocket() = strict(inner.createSocket())
        override fun createSocket(host: String?, port: Int) = strict(inner.createSocket(host, port))
        override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int) =
            strict(inner.createSocket(host, port, localHost, localPort))
        override fun createSocket(host: java.net.InetAddress?, port: Int) = strict(inner.createSocket(host, port))
        override fun createSocket(address: java.net.InetAddress?, port: Int, localAddress: java.net.InetAddress?, localPort: Int) =
            strict(inner.createSocket(address, port, localAddress, localPort))
    }
}
