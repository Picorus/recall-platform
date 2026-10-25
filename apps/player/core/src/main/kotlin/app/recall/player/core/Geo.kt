// P2.6: small, exact-enough geometry for one city, the same as the cloud's (packages/domain/src/geo.ts):
// great-circle distances, and a flat projection around a nearby point for distances to a border.
package app.recall.player.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

data class LatLng(val lat: Double, val lng: Double)

object Geo {
    const val EARTH_RADIUS_M = 6_371_008.8
    private const val RAD = Math.PI / 180

    /** Great-circle distance in metres. */
    fun distanceMeters(a: LatLng, b: LatLng): Double {
        val dLat = (b.lat - a.lat) * RAD
        val dLng = (b.lng - a.lng) * RAD
        val s1 = sin(dLat / 2)
        val s2 = sin(dLng / 2)
        val h = s1 * s1 + cos(a.lat * RAD) * cos(b.lat * RAD) * s2 * s2
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /** True when the point is inside the shape (ray casting). Points exactly on the border may go either way. */
    fun pointInRing(p: LatLng, ring: List<LatLng>): Boolean {
        var inside = false
        for (i in ring.indices) {
            val a = ring[i]
            val b = ring[(i + 1) % ring.size]
            if ((a.lat > p.lat) != (b.lat > p.lat)) {
                val lngAtLat = a.lng + (p.lat - a.lat) / (b.lat - a.lat) * (b.lng - a.lng)
                if (p.lng < lngAtLat) inside = !inside
            }
        }
        return inside
    }

    /** Shortest distance in metres from the point to the shape's border (0 means on it). */
    fun distanceToBorderMeters(p: LatLng, ring: List<LatLng>): Double {
        val q = project(p, p)
        var best = Double.POSITIVE_INFINITY
        for (i in ring.indices) {
            best = min(best, segmentDistance(q, project(ring[i], p), project(ring[(i + 1) % ring.size], p)))
        }
        return best
    }

    /** Metres east (x) and north (y) of `origin`. */
    private fun project(p: LatLng, origin: LatLng) = doubleArrayOf(
        (p.lng - origin.lng) * RAD * EARTH_RADIUS_M * cos(origin.lat * RAD),
        (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
    )

    private fun segmentDistance(p: DoubleArray, a: DoubleArray, b: DoubleArray): Double {
        val dx = b[0] - a[0]
        val dy = b[1] - a[1]
        val len2 = dx * dx + dy * dy
        val t = if (len2 == 0.0) 0.0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
        return hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
    }
}
