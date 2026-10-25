// P2.3.3: the box's line to the cloud, one per app process, started with the player. What the box
// needs is written at the warehouse after enrolment (docs/RUNBOOKS/screen-setup.md), in files/line/:
//   screen-id      the screen id (SCR-…)
//   broker         where the broker is, e.g. ssl://line.recall.example:8883
//   cert.pem       the box's certificate (from enrolment)
//   broker-ca.pem  the authority the broker's certificate comes from (the only one trusted)
// Without them the line does not start (the screen still plays from what it has, P2.6).
package app.recall.player

import android.content.Context
import android.os.SystemClock
import app.recall.player.core.Enrolment
import app.recall.player.core.LineTls
import app.recall.player.core.Outbox
import app.recall.player.core.PahoTransport
import app.recall.player.core.ScreenLine
import app.recall.player.core.TrustedClock
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicReference

object Line {
    /** The box's clock, set by the cloud here and by GPS (P2.8). */
    val clock = AtomicReference(TrustedClock())
    @Volatile private var line: ScreenLine? = null
    @Volatile var outbox: Outbox? = null
        private set

    @Synchronized
    fun start(context: Context) {
        if (line != null) return
        val app = context.applicationContext
        val dir = File(app.filesDir, "line")
        val need = listOf("screen-id", "broker", "cert.pem", "broker-ca.pem").map { File(dir, it) }
        if (need.any { !it.exists() }) {
            CrashLog.record(app, "line not started: not set up at the warehouse")
            return
        }
        val (screenId, broker, cert, brokerCa) = need.map { it.readText().trim() }
        val box = Outbox(File(app.filesDir, "outbox"))
        val key = AndroidKeyVault().privateKey(Enrolment.TLS_KEY)
        val factory = LineTls.socketFactory(key, cert, brokerCa)
        val random = SecureRandom()
        outbox = box
        line = ScreenLine(
            screenId = screenId,
            appVersion = BuildConfig.VERSION_NAME,
            outbox = box,
            transport = { PahoTransport(broker, screenId, factory) },
            clock = clock,
            mono = SystemClock::elapsedRealtime,
            random = { n -> (random.nextDouble() * n).toLong() },
            log = { android.util.Log.i("RecallLine", it) },
        ).also { it.start() }
    }

    /** A report was added to the outbox: send it soon. */
    fun nudge() = line?.nudge()
}
