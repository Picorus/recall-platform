// P2.3.3: the box's keys in the Android Keystore. Made inside the secure hardware where the box has it;
// the private half never leaves it: it signs plays (P2.7) and the secure line's handshake (P2.3.3).
package app.recall.player

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.recall.player.core.KeyVault
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

class AndroidKeyVault : KeyVault {
    private val store = KeyStore.getInstance(STORE).apply { load(null) }

    private fun ensure(alias: String) {
        if (store.containsAlias(alias)) return
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            // SHA-256 for plays and enrolment; the TLS handshake may ask for the others.
            .setDigests(
                KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384,
                KeyProperties.DIGEST_SHA512,
                KeyProperties.DIGEST_NONE,
            )
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).apply { initialize(spec) }.generateKeyPair()
    }

    override fun publicKey(alias: String): String {
        ensure(alias)
        return Base64.getEncoder().encodeToString(store.getCertificate(alias).publicKey.encoded)
    }

    override fun privateKey(alias: String): PrivateKey {
        ensure(alias)
        return store.getKey(alias, null) as PrivateKey
    }

    override fun sign(alias: String, bytes: ByteArray): String {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(privateKey(alias))
        s.update(bytes)
        return Base64.getEncoder().encodeToString(s.sign())
    }

    private companion object {
        const val STORE = "AndroidKeyStore"
    }
}
