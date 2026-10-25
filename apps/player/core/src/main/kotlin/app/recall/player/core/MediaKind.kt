// P2.5: is an ad file a picture or a video? Ad files are stored under their fingerprint, with no name
// to go by (P2.4), so the first bytes tell: PNG, JPEG and WebP are pictures (shown for the whole
// spot), anything else is handed to the video player (which says so if it cannot play it).
package app.recall.player.core

import java.io.File
import java.io.FileInputStream

enum class MediaKind { PICTURE, VIDEO }

object MediaKinds {
    fun of(file: File): MediaKind {
        val head = ByteArray(12)
        val n = runCatching { FileInputStream(file).use { it.read(head) } }.getOrDefault(0)
        return if (n >= 12 && isPicture(head)) MediaKind.PICTURE else MediaKind.VIDEO
    }

    private fun isPicture(h: ByteArray): Boolean {
        fun at(i: Int, vararg b: Int) = b.indices.all { h[i + it] == b[it].toByte() }
        return at(0, 0x89, 'P'.code, 'N'.code, 'G'.code) ||
            at(0, 0xFF, 0xD8, 0xFF) ||
            (at(0, 'R'.code, 'I'.code, 'F'.code, 'F'.code) && at(8, 'W'.code, 'E'.code, 'B'.code, 'P'.code))
    }
}
