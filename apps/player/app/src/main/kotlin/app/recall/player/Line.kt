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
import app.recall.player.core.DownKind
import app.recall.player.core.Enrolment
import app.recall.player.core.LineTls
import app.recall.player.core.Outbox
import app.recall.player.core.PahoTransport
import app.recall.player.core.PlayLog
import app.recall.player.core.PlaySigner
import app.recall.player.core.ScreenLine
import app.recall.player.core.TrustedClock
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.JsonObject

object Line {
    /** The box's clock, set by the cloud here and by GPS (P2.8). */
    val clock = AtomicReference(TrustedClock())
    @Volatile private var line: ScreenLine? = null
    @Volatile var outbox: Outbox? = null
        private set

    /**
     * Starts the line in the background: reading a large outbox and the keystore must never hold up
     * the screen (a box back after days offline would freeze at boot, review P2.3.3).
     */
    fun startInBackground(context: Context) {
        val app = context.applicationContext
        Thread({
            runCatching { start(app) }.onFailure { CrashLog.record(app, "line: ${it.javaClass.simpleName}") }
        }, "recall-line-start").start()
    }

    @Synchronized
    fun start(context: Context) {
        if (line != null) return
        val app = context.applicationContext
        val dir = File(app.filesDir, "line")
        val need = listOf("screen-id", "broker", "cert.pem", "broker-ca.pem").map { File(dir, it) }
        val vault = AndroidKeyVault()
        // First, with the screen id alone: what to play where (P2.6) and the signed play log (P2.7),
        // so no play counted early after a boot is lost (review P2.7).
        val screenId = need[0].takeIf { it.exists() }?.readText()?.trim()
        if (screenId != null) {
            runCatching { Schedule.start(app, screenId) }.onFailure { CrashLog.record(app, "schedule not started: ${it.javaClass.simpleName}") }
            runCatching { startPlays(app, screenId, vault) }.onFailure { CrashLog.record(app, "plays not started: ${it.javaClass.simpleName}") }
            // GPS (P2.8): the area each second, the minutes and live positions, GPS time.
            val scheduler = Schedule.scheduler
            val box = outbox
            if (scheduler != null && box != null) {
                runCatching { Gps.start(app, scheduler, box) }.onFailure { CrashLog.record(app, "gps not started: ${it.javaClass.simpleName}") }
            }
        }
        // The ad files are kept and checked whether or not the line can open (P2.4). A problem
        // there must not keep the line (and so the play reports) from starting.
        runCatching { Ads.start(app) }.onFailure { CrashLog.record(app, "ads not started: ${it.javaClass.simpleName}") }
        val box = outbox
        if (screenId == null || box == null || need.any { !it.exists() }) {
            CrashLog.record(app, "line not started: not set up at the warehouse")
            return
        }
        val (_, broker, cert, brokerCa) = need.map { it.readText().trim() }
        // The key must be the one enrolled, and the certificate must be for it: a box set up wrongly
        // says so here instead of failing every handshake quietly (review, P2.3.3).
        if (!vault.has(Enrolment.TLS_KEY)) {
            CrashLog.record(app, "line not started: the box has no line key (enrol it again)")
            return
        }
        val certKey = Base64.getEncoder().encodeToString(LineTls.certificate(cert).publicKey.encoded)
        if (certKey != vault.publicKey(Enrolment.TLS_KEY)) {
            CrashLog.record(app, "line not started: the certificate is not for this box's key")
            return
        }
        val key = vault.privateKey(Enrolment.TLS_KEY)
        val factory = LineTls.socketFactory(key, cert, brokerCa)
        val random = SecureRandom()
        line = ScreenLine(
            screenId = screenId,
            appVersion = BuildConfig.VERSION_NAME,
            outbox = box,
            transport = { PahoTransport(broker, screenId, factory) },
            clock = clock,
            mono = SystemClock::elapsedRealtime,
            random = { n -> (random.nextDouble() * n).toLong() },
            log = { android.util.Log.i("RecallLine", it) },
            onMessage = { kind, payload ->
                when (kind) {
                    DownKind.FILES -> Ads.onList(payload)
                    else -> Schedule.onMessage(kind, payload)
                }
            },
        ).also { it.start() }
    }

    /**
     * The outbox and the signed play log (P2.7), whether or not the line can open: plays are kept on
     * storage until it can. Plays are signed only with the key made at enrolment. Once per process.
     */
    private fun startPlays(app: Context, screenId: String, vault: AndroidKeyVault) {
        if (outbox != null) return
        val signs = vault.has(Enrolment.PLAY_KEY)
        val seal: (Long, JsonObject) -> JsonObject = if (signs) PlaySigner(screenId, vault)::seal else { _, r -> r }
        val box = Outbox(File(app.filesDir, "outbox"), seal = seal)
        outbox = box
        if (!signs) {
            CrashLog.record(app, "plays not recorded: the box has no play key (enrol it again)")
            return
        }
        Playback.attach(
            PlayLog(
                outbox = box,
                places = { t -> Schedule.scheduler?.where(t) },
                mark = Playback.markFile(app),
                stored = {
                    nudge()
                    Gps.loop?.played()
                },
                log = { android.util.Log.i("RecallPlays", it) },
            ),
        )
    }

    /** A report was added to the outbox: send it soon. */
    fun nudge() = line?.nudge()
}
