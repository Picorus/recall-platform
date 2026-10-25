// P2.4: downloads ad files from storage over HTTPS (never plain HTTP), carrying on a download cut
// short by a weak 4G link from where it stopped (an HTTP range request).
package app.recall.player.core

import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocketFactory

class HttpsFetcher(
    /** Trust for the storage's certificate: the system's own authorities unless a test gives one. */
    private val tls: SSLSocketFactory? = null,
    private val connectMs: Int = 15_000,
    private val readMs: Int = 30_000,
) : Fetcher {
    override fun fetch(url: String, from: Long): Fetched {
        require(from >= 0)
        val c = URL(url).openConnection() as? HttpsURLConnection ?: throw IOException("not an HTTPS link")
        tls?.let { c.sslSocketFactory = it }
        c.connectTimeout = connectMs
        c.readTimeout = readMs
        // A redirect is followed only to another HTTPS address (Java never follows HTTPS to HTTP).
        c.instanceFollowRedirects = true
        c.useCaches = false
        // The bytes exactly as stored: a phone's automatic unzipping applies to whole downloads but
        // not to resumed ones, which would then never match (review, P2.4).
        c.setRequestProperty("Accept-Encoding", "identity")
        if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
        try {
            return when (val code = c.responseCode) {
                200 -> Fetched(0, c.inputStream)
                206 -> {
                    // "Content-Range: bytes 1000-4999/5000": the part must start where we asked.
                    val start = Regex("^bytes (\\d+)-").find(c.getHeaderField("Content-Range") ?: "")?.groupValues?.get(1)?.toLongOrNull()
                    if (start != from) throw IOException("the server sent the wrong part")
                    Fetched(start, c.inputStream)
                }
                else -> throw IOException("the server said $code")
            }
        } catch (e: Exception) {
            c.disconnect()
            throw e
        }
    }
}
