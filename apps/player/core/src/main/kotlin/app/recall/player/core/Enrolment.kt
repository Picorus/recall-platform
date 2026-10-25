// P2.1: enrolling the box at our warehouse. The box makes two keys inside its secure store (one for
// the secure line, one for signing plays); only the public halves leave it, in a request signed with
// both, so the cloud knows the box really holds them. Same bytes as enrolmentBytes() in
// packages/domain/src/screen-identity.ts.
package app.recall.player.core

import java.security.PrivateKey

/** Where the box keeps its private keys. On the box: the Android Keystore (never exported). */
interface KeyVault {
    /** Makes an ECDSA P-256 key under `alias` if there is none; returns its public key (SPKI DER, base64). */
    fun publicKey(alias: String): String

    /** Signs with the key under `alias`: ECDSA P-256 with SHA-256, DER, base64. */
    fun sign(alias: String, bytes: ByteArray): String

    /**
     * The private key under `alias`, for the secure line's handshake (P2.3.3). On the box this is a
     * handle into the Android Keystore: it signs, it cannot be read out.
     */
    fun privateKey(alias: String): PrivateKey
}

data class EnrolmentRequest(
    val hardwareSerial: String,
    val model: String,
    val tlsPublicKey: String,
    val playPublicKey: String,
    /** UTC seconds. */
    val madeAt: Long,
) {
    /** The exact bytes both keys sign. */
    fun bytes(): String =
        listOf("RECALL-ENROL-1", hardwareSerial, model, tlsPublicKey, playPublicKey, madeAt.toString())
            .joinToString("\n")
}

data class SignedEnrolment(
    val request: EnrolmentRequest,
    val tlsSignature: String,
    val playSignature: String,
)

object Enrolment {
    const val TLS_KEY = "recall-tls"
    const val PLAY_KEY = "recall-play-k1"

    /** Builds and signs the enrolment request for this box. */
    fun request(vault: KeyVault, hardwareSerial: String, model: String, now: Long): SignedEnrolment {
        val request = EnrolmentRequest(
            hardwareSerial = hardwareSerial,
            model = model,
            tlsPublicKey = vault.publicKey(TLS_KEY),
            playPublicKey = vault.publicKey(PLAY_KEY),
            madeAt = now,
        )
        val bytes = request.bytes().toByteArray(Charsets.UTF_8)
        return SignedEnrolment(request, vault.sign(TLS_KEY, bytes), vault.sign(PLAY_KEY, bytes))
    }
}
