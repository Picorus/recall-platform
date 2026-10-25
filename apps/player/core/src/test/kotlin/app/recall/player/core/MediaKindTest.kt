package app.recall.player.core

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals

class MediaKindTest {
    private val dir = Files.createTempDirectory("media").toFile()
    private fun file(vararg b: Int) = File(dir, "f${b.hashCode()}").apply { writeBytes(ByteArray(b.size) { b[it].toByte() } + ByteArray(20)) }
    private fun asset(name: String) = File(System.getProperty("recall.androidTestAssets"), name)

    @Test
    fun `pictures by their first bytes, everything else to the video player`() {
        assertEquals(MediaKind.PICTURE, MediaKinds.of(asset("ad-picture.png")))
        assertEquals(MediaKind.VIDEO, MediaKinds.of(asset("ad-video.mp4")))
        assertEquals(MediaKind.VIDEO, MediaKinds.of(asset("broken.bin")))
        assertEquals(MediaKind.PICTURE, MediaKinds.of(file(0xFF, 0xD8, 0xFF, 0xE0)))
        assertEquals(MediaKind.PICTURE, MediaKinds.of(file('R'.code, 'I'.code, 'F'.code, 'F'.code, 1, 2, 3, 4, 'W'.code, 'E'.code, 'B'.code, 'P'.code)))
        assertEquals(MediaKind.VIDEO, MediaKinds.of(File(dir, "missing")))
        assertEquals(MediaKind.VIDEO, MediaKinds.of(File(dir, "empty").apply { writeBytes(ByteArray(0)) }))
    }
}
