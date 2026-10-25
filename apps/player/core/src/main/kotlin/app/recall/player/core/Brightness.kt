// P2.10: how bright the screen shines. Brighter by day, dimmer at night, never blinding riders behind
// (plan). The box knows day from night by where the sun is (worked out from the time and the bike's
// position, no signal needed); a light sensor, where the box has one, then follows the light around
// it within safe limits:
//  - by day never below `dayFloor`, so an ad stays readable even when the sensor is covered or dirty;
//  - at night never above `nightCap`, so a headlight shining on the sensor cannot make it blinding;
//  - dusk and dawn move smoothly from one to the other as the sun goes down or comes up.
// The light reading is the middle of the last few seconds (a passing headlight does not count) and
// the screen changes by at most a few points a second: never a flicker. All limits are settings.
package app.recall.player.core

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.log10
import kotlin.math.sin

data class BrightnessRules(
    /** By day, percent of full: without a sensor, and the lowest with one. */
    val day: Int = 100,
    val dayFloor: Int = 60,
    /** At night: without a sensor, the lowest and the highest with one. */
    val night: Int = 30,
    val nightFloor: Int = 15,
    val nightCap: Int = 35,
    /** Light (lux) at or under which the sensor reads "dark", and at or over which "full daylight". */
    val darkLux: Double = 10.0,
    val brightLux: Double = 10_000.0,
    /** Sun height (degrees): at or above `dayFrom` it is day, at or below `nightFrom` night. */
    val dayFrom: Double = 6.0,
    val nightFrom: Double = -6.0,
    /** Most the screen changes in one second (percentage points). */
    val stepPerSecond: Int = 5,
    /** Light readings kept (one a second); their middle one is used. */
    val lightSeconds: Int = 10,
) {
    init {
        require(nightFloor in 1..nightCap && night in nightFloor..nightCap && nightCap <= dayFloor)
        require(dayFloor <= day && day <= 100 && stepPerSecond > 0 && lightSeconds > 0)
        require(darkLux > 0 && brightLux > darkLux && nightFrom < dayFrom)
    }
}

object Sun {
    /** Hitech City: where the sun is reckoned before the box has a position. */
    val HYDERABAD = LatLng(17.4504, 78.381)

    /** The sun's height above the horizon (degrees) at `utcMs`, seen from `at`. Good to about a degree. */
    fun elevation(utcMs: Long, at: LatLng): Double {
        val rad = PI / 180
        val d = utcMs / 86_400_000.0 + 2_440_587.5 - 2_451_545.0 // days since 1 Jan 2000, noon
        val g = (357.529 + 0.98560028 * d) * rad
        val q = 280.459 + 0.98564736 * d
        val l = (q + 1.915 * sin(g) + 0.020 * sin(2 * g)) * rad
        val e = (23.439 - 0.00000036 * d) * rad
        val ra = atan2(cos(e) * sin(l), cos(l))
        val dec = asin(sin(e) * sin(l))
        val gmst = (18.697374558 + 24.06570982441908 * d) * 15 * rad
        val h = gmst + at.lng * rad - ra
        val lat = at.lat * rad
        return asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(h)) / rad
    }
}

/** Works out the screen's brightness second by second. Not thread-safe (one caller, once a second). */
class Brightness(private val rules: BrightnessRules = BrightnessRules()) {
    private val light = ArrayDeque<Double>()
    private var current: Int? = null

    /** Where the target sits between night (0) and day (1), from the sun's height. */
    private fun daylight(elevation: Double): Double =
        ((elevation - rules.nightFrom) / (rules.dayFrom - rules.nightFrom)).coerceIn(0.0, 1.0)

    /** How light it is around the box, 0 (dark) to 1 (full daylight), on a log scale like the eye. */
    private fun lightness(lux: Double): Double =
        ((log10(maxOf(lux, 1e-3)) - log10(rules.darkLux)) / (log10(rules.brightLux) - log10(rules.darkLux))).coerceIn(0.0, 1.0)

    /** Where the screen should be now, before smoothing (percent). */
    fun target(elevation: Double, lux: Double?): Int {
        val k = daylight(elevation)
        val (dayPart, nightPart) = if (lux == null) {
            rules.day.toDouble() to rules.night.toDouble()
        } else {
            val l = lightness(lux)
            (rules.dayFloor + (rules.day - rules.dayFloor) * l) to (rules.nightFloor + (rules.nightCap - rules.nightFloor) * l)
        }
        return Math.round(nightPart + (dayPart - nightPart) * k).toInt()
    }

    /**
     * One second: the sun's height now and the sensor's reading this second (null without one, or
     * without a reading). Returns the brightness to set (percent, 1–100).
     */
    fun next(elevation: Double, lux: Double?): Int {
        if (lux != null && lux.isFinite() && lux >= 0) {
            light.addLast(lux)
            while (light.size > rules.lightSeconds) light.removeFirst()
        } else if (light.isNotEmpty()) {
            // No reading this second: old ones age out, so a sensor that stops is soon not followed.
            light.removeFirst()
        }
        // The lower middle when even: in doubt, the dimmer side (never blinding).
        val middle = light.sorted().let { if (it.isEmpty()) null else it[(it.size - 1) / 2] }
        val want = target(elevation, middle)
        val now = current ?: want
        val step = (want - now).coerceIn(-rules.stepPerSecond, rules.stepPerSecond)
        return (now + step).coerceIn(1, 100).also { current = it }
    }
}

/**
 * The LED panel's brightness control. On the box today: the Android display's own brightness; with
 * the panel hardware, its sending card's control (vendor SDK), behind this same call.
 */
fun interface Panel {
    /** Sets the panel's brightness, percent of full (1–100). */
    fun brightness(percent: Int)
}
