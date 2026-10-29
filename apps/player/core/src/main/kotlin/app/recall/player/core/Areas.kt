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
    /** Closer than this to a border (metres) is on the border: the cloud's ON_BORDER_M. */
    const val ON_BORDER_M = 0.001

    /**
     * Where a point is (P1.1.7: neighbouring areas may share a border). Only areas that are on count.
     * 1. Inside an area (more than 1 mm from its border): that area; inside always wins over
     *    another area's edge zone.
     * 2. On a border (within 1 mm), such as the line two neighbours share: the smaller id of the
     *    areas whose border it is on. Checked against the cloud's cases (test-vectors/areas-locate.json).
     * 3. Otherwise the nearer edge zone; nearer by 1 mm or less is a tie, and ties go to the smaller id.
     */
    fun locate(point: LatLng, areas: List<AreaVersion>): Place {
        // Ordered by id code unit by code unit, as the cloud compares strings.
        val sorted = areas.filter { it.active }.sortedWith { a, b -> a.areaId.compareTo(b.areaId) }
        val known = HashMap<Int, Double>()
        fun border(i: Int) = known.getOrPut(i) { Geo.distanceToBorderMeters(point, sorted[i].ring) }
        for (i in sorted.indices) {
            val a = sorted[i]
            if (Geo.pointInRing(point, a.ring) && border(i) > ON_BORDER_M) return Place.Inside(a.areaId, a.version)
        }
        for (i in sorted.indices) if (border(i) <= ON_BORDER_M) return Place.Inside(sorted[i].areaId, sorted[i].version)
        var best: AreaVersion? = null
        var bestMeters = 0.0
        for (i in sorted.indices) {
            val a = sorted[i]
            val m = border(i)
            if (m <= a.edgeMeters && (best == null || m < bestMeters - ON_BORDER_M)) {
                best = a
                bestMeters = m
            }
        }
        return best?.let { Place.Edge(it.areaId, it.version, bestMeters) } ?: Place.Outside
    }

    /** What a position counts as for one area's booking line: the cloud's lineCount (P1.5.3, P1.1.7). */
    enum class LineCount(val word: String) {
        INSIDE("inside"),
        EDGE("edge"),
        INSIDE_ANOTHER("inside another area"),
        OUTSIDE("outside"),
        ;

        /** A brand play here would count for that line (edge plays up to their share). */
        val counts get() = this == INSIDE || this == EDGE
    }

    /**
     * What `point` counts as for `areaId`'s line, exactly as the cloud judges a play: inside it; in its
     * edge zone where that lies outside every area; inside another area (never this line's, though the
     * edge zone may reach in, as neighbours share borders); or outside. Shared cases: areas-locate.json.
     */
    fun lineCount(point: LatLng, areaId: String, areas: List<AreaVersion>): LineCount {
        val area = areas.firstOrNull { it.areaId == areaId && it.active } ?: return LineCount.OUTSIDE
        val where = locate(point, areas)
        if (where is Place.Inside) return if (where.areaId == areaId) LineCount.INSIDE else LineCount.INSIDE_ANOTHER
        return if (locate(point, listOf(area)) is Place.Outside) LineCount.OUTSIDE else LineCount.EDGE
    }
}
