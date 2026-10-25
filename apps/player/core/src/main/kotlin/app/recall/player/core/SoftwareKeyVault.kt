package app.recall.player.core

import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * Keys kept in memory: for tests and the emulator only. The box uses the Android Keystore, where the
 * private key never leaves the secure hardware.
 */
class SoftwareKeyVault : KeyVault {
    private val keys = mutableMapOf<String, KeyPair>()

    private fun pair(alias: String): KeyPair = keys.getOrPut(alias) {
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    }

    override fun publicKey(alias: String): String = Base64.getEncoder().encodeToString(pair(alias).public.encoded)

    override fun privateKey(alias: String): PrivateKey = pair(alias).private

    override fun sign(alias: String, bytes: ByteArray): String {
        val s = Signature.getInstance("SHA256withECDSA")
        s.initSign(pair(alias).private)
        s.update(bytes)
        return Base64.getEncoder().encodeToString(s.sign())
    }
}
