// P2.6: where the bike is: inside an area, in an area's edge zone, or outside every area that is on.
// The same rule as the cloud's (packages/domain/src/areas.ts locate, P1.1.4).
package app.recall.player.core

/** An area as the screen needs it (the version in force now). */
data class AreaVersion(
    val areaId: String,
    val version: Int,
    val ring: List<LatLng>,
    /** The edge zone around the area, metres (P1.1.1). */
    val edgeMeters: Double,
    /** Off: not sold, and plays and hours there do not count. */
    val active: Boolean,
)

sealed interface Place {
    /** "inside:hyd-madhapur@3", "edge:hyd-madhapur@3" or "outside": a stable key (the cloud's placeKey). */
    val key: String

    data class Inside(val areaId: String, val version: Int) : Place {
        override val key get() = "inside:$areaId@$version"
    }

    data class Edge(val areaId: String, val version: Int, val metersOutside: Double) : Place {
        override val key get() = "edge:$areaId@$version"
    }

    data object Outside : Place {
        override val key get() = "outside"
    }
}

object Areas {
    /**
     * Where a point is. A point in two edge zones belongs to the nearer area; ties go to the smaller
     * id. Only areas that are on count.
     */
    fun locate(point: LatLng, areas: List<AreaVersion>): Place {
        // Ordered by id code unit by code unit, as the cloud compares strings.
        val sorted = areas.filter { it.active }.sortedWith { a, b -> a.areaId.compareTo(b.areaId) }
        for (a in sorted) if (Geo.pointInRing(point, a.ring)) return Place.Inside(a.areaId, a.version)
        var best: AreaVersion? = null
        var bestMeters = 0.0
        for (a in sorted) {
            val m = Geo.distanceToBorderMeters(point, a.ring)
            if (m <= a.edgeMeters && (best == null || m < bestMeters)) {
                best = a
                bestMeters = m
            }
        }
        return best?.let { Place.Edge(it.areaId, it.version, bestMeters) } ?: Place.Outside
    }
}
