// P2.10: the screen's brightness on the box. Once a second: the sun's height over Hyderabad (from the
// trusted time, or the box's own clock before there is one: brightness needs no proof) and the light
// sensor's latest reading, where the box has one, go to Brightness, which sets the panel. A city is
// small for the sun: Hitech City's sky serves the whole fleet.
package app.recall.player

import android.app.Activity
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.recall.player.core.Brightness
import app.recall.player.core.Panel
import app.recall.player.core.Sun

class ScreenLight(private val activity: Activity) {
    private val main = Handler(Looper.getMainLooper())
    private val brightness = Brightness()
    private val sensors = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val sensor: Sensor? = sensors.getDefaultSensor(Sensor.TYPE_LIGHT)
    @Volatile private var lux: Float? = null
    @Volatile private var luxAt = 0L

    /** The display's own brightness, until the panel's sending card is wired (vendor SDK). */
    private val panel = Panel { percent ->
        activity.window.attributes = activity.window.attributes.apply { screenBrightness = percent / 100f }
    }

    private val listener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            lux = event.values.firstOrNull()
            luxAt = SystemClock.elapsedRealtime()
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    }

    private val tick = object : Runnable {
        override fun run() {
            runCatching {
                val mono = SystemClock.elapsedRealtime()
                val now = Line.clock.get().now(mono) ?: System.currentTimeMillis()
                // Light sensors report on change only: a steady room may not report for a while.
                val reading = lux?.takeIf { mono - luxAt < 60_000 }?.toDouble()
                panel.brightness(brightness.next(Sun.elevation(now, Sun.HYDERABAD), reading))
            }
            main.postDelayed(this, 1_000)
        }
    }

    /** Main thread. */
    fun start() {
        sensor?.let { sensors.registerListener(listener, it, SensorManager.SENSOR_DELAY_NORMAL) }
        main.removeCallbacks(tick)
        main.post(tick)
    }

    /** Main thread. */
    fun stop() {
        main.removeCallbacks(tick)
        sensors.unregisterListener(listener)
    }
}
