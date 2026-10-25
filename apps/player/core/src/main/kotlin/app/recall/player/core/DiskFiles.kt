// Writing to the box's storage so a power cut never leaves a half file behind (outbox P2.3, ad store
// P2.4). The box loses power whenever the rider switches the bike off.
package app.recall.player.core

import java.io.File
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

internal object DiskFiles {
    /** Writes a small file whole or not at all (a power cut leaves the old one). */
    fun writeAtomically(f: File, text: String) {
        val tmp = File(f.parentFile, "${f.name}.tmp")
        FileOutputStream(tmp).use {
            it.write(text.toByteArray())
            it.fd.sync()
        }
        moveAtomically(tmp, f)
    }

    /** Renames a finished file into place in one step, and makes the new name itself survive. */
    fun moveAtomically(from: File, to: File) {
        Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        syncDir(to.parentFile)
    }

    /** Makes a new or renamed file's name itself survive a power cut (where the system allows). */
    fun syncDir(dir: File) {
        try {
            FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
            // Some systems cannot open a folder this way; their journal orders it instead.
        }
    }
}
