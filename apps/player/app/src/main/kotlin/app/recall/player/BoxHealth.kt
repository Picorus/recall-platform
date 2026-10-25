// P2.11: the box's health on Android. Once a minute (by the trusted time): battery charge, charging
// and temperature, the box's own temperature (where the system lets us read it), free storage, the
// mobile signal, and the player's counters, sent through the outbox. The LED panel's faults and the
// tamper switch come with the panel hardware (its sending card); until then they go as unknown.
package app.recall.player

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.HandlerThread
import android.os.StatFs
import android.os.SystemClock
import android.telephony.CellInfo
import android.telephony.TelephonyManager
import android.util.Log
import app.recall.player.core.HealthCounters
import app.recall.player.core.HealthReading
import app.recall.player.core.HealthReporter
import app.recall.player.core.Outbox
import java.io.File

object BoxHealth {
    @Volatile private var started = false
    @Volatile private var appContext: Context? = null
    private val startedAt = SystemClock.elapsedRealtime()

    @Synchronized
    fun start(context: Context, outbox: Outbox) {
        if (started) return
        started = true
        val app = context.applicationContext
        appContext = app
        val reporter = HealthReporter(
            app = BuildConfig.VERSION_NAME,
            read = { read(app) },
            counters = ::counters,
            clockDisagree = { Line.clock.get().disagree(SystemClock.elapsedRealtime()) },
            send = { report, at ->
                outbox.add(report, at)
                Line.nudge()
            },
            log = { Log.i("RecallHealth", it) },
            appCode = BuildConfig.VERSION_CODE,
        )
        val handler = Handler(HandlerThread("recall-health").apply { start() }.looper)
        handler.post(object : Runnable {
            override fun run() {
                val mono = SystemClock.elapsedRealtime()
                Line.clock.get().now(mono)?.let { now ->
                    runCatching { reporter.tick(Math.floorDiv(now, 1_000L), (mono - startedAt) / 1_000) }
                }
                handler.postDelayed(this, 5_000)
            }
        })
    }

    private fun counters() = HealthCounters(
        spotsNotCounted = Playback.spotsNotCounted,
        playsNotStored = Playback.playLog?.failed ?: 0,
        messagesRefused = Schedule.scheduler?.refused ?: 0,
        gpsMissedSeconds = Gps.loop?.missedSeconds ?: 0,
        adsMissing = Playback.adsMissing,
        crashes = appContext?.let(CrashLog::count) ?: 0,
    )

    /** What the box reads about itself now (also for the fitting check, P2.14). */
    fun read(app: Context): HealthReading {
        val battery = runCatching { app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }.getOrNull()
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val tenths = battery?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE) ?: Int.MIN_VALUE
        return HealthReading(
            batteryPct = if (level >= 0 && scale > 0) level * 100 / scale else null,
            charging = when (status) {
                BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
                BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
                else -> null
            },
            batteryC = if (tenths != Int.MIN_VALUE) Math.round(tenths / 10.0).toInt() else null,
            boxC = boxTemperature(),
            freeMb = runCatching { StatFs(app.filesDir.path).availableBytes / (1024 * 1024) }.getOrDefault(0),
            signalDbm = signal(app),
            ledFault = null, // the panel's sending card (with the hardware)
            tamper = null,
        )
    }

    /** The processor's temperature where the system shows it (millidegrees in a thermal zone). */
    private fun boxTemperature(): Int? = runCatching {
        File("/sys/class/thermal/thermal_zone0/temp").readText().trim().toLong().let { Math.round(it / 1000.0).toInt() }
    }.getOrNull()

    private fun signal(app: Context): Int? = runCatching {
        val tm = app.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        tm.signalStrength?.cellSignalStrengths?.map { it.dbm }?.firstOrNull { it != CellInfo.UNAVAILABLE }
    }.getOrNull()
}
