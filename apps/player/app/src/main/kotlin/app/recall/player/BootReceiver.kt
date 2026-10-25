// P2.2: after power-up (or an update of the player) start the watchdog, which starts the player.
// The player is also the home screen, so Android starts it on boot by itself; this is the backstop.
package app.recall.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            context.startForegroundService(Intent(context, WatchdogService::class.java))
        }
    }
}
