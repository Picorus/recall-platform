// P2.8.2: the GPS service on the box, one per app process. The GPS chip reports about once a second;
// each reading sets the box's clock from GPS time (P2.3.1: until the cloud answers) and goes to the
// GPS loop, which every second by the trusted time cleans it, decides the area for the local
// scheduler (P2.6), and sends minute summaries and live positions through the outbox (P2.8.1).
// Everything runs on the service's own thread: the screen is never held up.
package app.recall.player

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import app.recall.player.core.GpsLoop
import app.recall.player.core.LocalScheduler
import app.recall.player.core.Minutes
import app.recall.player.core.Outbox
import java.io.File

object Gps {
    @Volatile var loop: GpsLoop? = null
        private set

    /** Starts reading GPS (once per process). The scheduler and outbox must be there. */
    @Synchronized
    fun start(context: Context, scheduler: LocalScheduler, outbox: Outbox) {
        if (loop != null) return
        val app = context.applicationContext
        val log: (String) -> Unit = { Log.i("RecallGps", it) }
        val g = GpsLoop(
            send = { report, at ->
                outbox.add(report, at)
                Line.nudge()
            },
            areas = scheduler::areas,
            onSecond = scheduler::onSecond,
            // Seconds are marked against the POC month's zone the cloud sent (review m1).
            minutes = Minutes(scheduler::payZoneAt),
            // The minute in progress, kept: the box loses power whenever the bike is switched off.
            keep = File(app.filesDir, "gps-minute"),
            log = log,
        )
        loop = g
        val thread = HandlerThread("recall-gps").apply { start() }
        val handler = Handler(thread.looper)
        handler.post(Ticker(app, g, handler))
    }

    // The permission is checked just below (lint does not follow it through the early return).
    @SuppressLint("MissingPermission")
    /** Starts listening to the GPS chip; false when it cannot yet (tried again later). */
    private fun listen(app: Context, g: GpsLoop, handler: Handler): Boolean {
        // As device owner the player grants itself location (Kiosk); it may come after the start.
        if (app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return false
        val lm = app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val listener = LocationListener { loc: Location ->
            val mono = loc.elapsedRealtimeNanos / 1_000_000
            Line.clock.updateAndGet { it.withGps(loc.time, mono) }
            // When the fix was taken, not when it reached us: a late one is not taken as fresh.
            g.onFix(loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy.toDouble() else null, mono)
        }
        return try {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1_000L, 0f, listener, handler.looper)
            true
        } catch (e: Exception) {
            Log.w("RecallGps", "gps not started: ${e.javaClass.simpleName}")
            false
        }
    }

    /** Ticks at the start of every second of the trusted time. */
    private class Ticker(private val app: Context, private val g: GpsLoop, private val handler: Handler) : Runnable {
        private var listening = false
        private var nextTry = 0L

        override fun run() {
            val mono = SystemClock.elapsedRealtime()
            // Until GPS listens (no permission yet, or no GPS chip answered): tried again every 30 s.
            if (!listening && mono >= nextTry) {
                listening = runCatching { Gps.listen(app, g, handler) }.getOrDefault(false)
                if (!listening) {
                    if (nextTry == 0L) CrashLog.record(app, "gps not listening yet: trying every 30 s")
                    nextTry = mono + 30_000
                }
            }
            val now = Line.clock.get().now(mono)
            var wait = 1_000L
            if (now != null) {
                runCatching { g.tick(Math.floorDiv(now, 1_000L), mono) }
                    .onFailure { Log.w("RecallGps", "tick failed: ${it.javaClass.simpleName}: ${it.message}") }
                // Just after the next second begins.
                wait = 1_000L - Math.floorMod(now, 1_000L) + 20
            }
            handler.postDelayed(this, wait)
        }
    }
}
