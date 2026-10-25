// P2.13: new player versions on the box. The cloud offers a version when this screen is in the
// rollout's stage (or the rollback build); the updater (core) downloads and checks it, and the
// package installer puts it in place. As device owner the player installs without anyone tapping;
// Android then restarts it (BootReceiver, on "package replaced"). Each health report carries the
// version and the box's crash count, which is how the cloud judges the rollout.
package app.recall.player

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import app.recall.player.core.HttpsFetcher
import app.recall.player.core.UpdateFile
import app.recall.player.core.Updater
import java.io.File

object Updates {
    @Volatile private var updater: Updater? = null
    const val RESULT = "app.recall.player.INSTALL_RESULT"

    @Synchronized
    fun start(context: Context) {
        if (updater != null) return
        val app = context.applicationContext
        updater = Updater(
            dir = File(app.filesDir, "updates"),
            ownCode = BuildConfig.VERSION_CODE,
            fetcher = HttpsFetcher(),
            install = { file, u -> install(app, file, u) },
            log = { Log.i("RecallUpdate", it) },
        )
    }

    /** An update message from the cloud (the line's thread). */
    fun onUpdate(payload: ByteArray) {
        updater?.onUpdate(String(payload, Charsets.UTF_8))
    }

    /** Hands a checked file to the package installer; the result arrives in InstallResult. */
    private fun install(app: Context, file: File, u: UpdateFile) {
        if (!Kiosk.isDeviceOwner(app)) error("not device owner: cannot install by itself")
        val installer = app.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(app.packageName)
            setSize(file.length())
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("player-${u.versionCode}.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val result = PendingIntent.getBroadcast(
                app,
                id,
                Intent(RESULT).setPackage(app.packageName).putExtra("version", u.versionName),
                // The installer adds the outcome to the intent, so it must be able to fill it in.
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            session.commit(result.intentSender)
        }
    }
}

/** What the package installer says about an install (a failed one is tried again with the next offer). */
class InstallResult : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val version = intent.getStringExtra("version") ?: "?"
        if (status != PackageInstaller.STATUS_SUCCESS) {
            val why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"
            CrashLog.record(context, "update $version not installed: ${why.take(120)}")
        }
    }
}
