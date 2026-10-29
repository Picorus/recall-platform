package app.recall.player.core

import java.io.File
import kotlin.math.abs
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * P1.1.7: neighbouring areas may share a border. The same shared cases the cloud's `locate` passes
 * (packages/domain/test-vectors/areas-locate.json): points on shared borders and corners, just off
 * them, inside one area and in another's edge zone.
 */
class AreasLocateTest {
    private val v = Json.parseToJsonElement(File(System.getProperty("recall.vectors"), "areas-locate.json").readText()).jsonObject
    private fun num(o: JsonObject, k: String) = o.getValue(k).jsonPrimitive.double

    private val areas = v.getValue("areas").jsonArray.map { it.jsonObject }.map { a ->
        AreaVersion(
            a.getValue("areaId").jsonPrimitive.content,
            a.getValue("version").jsonPrimitive.int,
            a.getValue("ring").jsonArray.map { p -> p.jsonObject.let { LatLng(num(it, "lat"), num(it, "lng")) } },
            num(a, "edgeMeters"),
            a.getValue("active").jsonPrimitive.boolean,
        )
    }
    private val cases = v.getValue("cases").jsonArray.map { it.jsonObject }

    @Test
    fun `the 1 mm border is the cloud's`() {
        assertEquals(num(v, "onBorderM"), Areas.ON_BORDER_M)
    }

    @Test
    fun `every shared case gives the cloud's place`() {
        assertTrue(cases.size >= 20)
        for (c in cases) {
            val name = c.getValue("name").jsonPrimitive.content
            val place = Areas.locate(LatLng(num(c, "lat"), num(c, "lng")), areas)
            assertEquals(c.getValue("place").jsonPrimitive.content, place.key, name)
            val m = c["metersOutside"]?.takeIf { it !is JsonNull }?.jsonPrimitive?.double
            if (m != null) {
                val edge = place as? Place.Edge ?: error("$name: not an edge place")
                assertTrue(abs(edge.metersOutside - m) < 1e-6, "$name: ${edge.metersOutside} vs $m")
            }
        }
    }

    @Test
    fun `the same answer whatever order the areas come in`() {
        for (c in cases) {
            val p = LatLng(num(c, "lat"), num(c, "lng"))
            assertEquals(Areas.locate(p, areas).key, Areas.locate(p, areas.reversed()).key)
            assertEquals(Areas.locate(p, areas).key, Areas.locate(p, areas.shuffled(java.util.Random(7))).key)
        }
    }

    @Test
    fun `every point along a shared border belongs to exactly one area, the smaller id`() {
        // The north-south border hyd-a and hyd-b share, and the slanted one of hyd-s1 and hyd-s2.
        for (i in 0..1000) {
            val f = i / 1000.0
            assertEquals("inside:hyd-a@1", Areas.locate(LatLng(17.4 + f * 0.01, 78.41), areas).key)
            assertEquals("inside:hyd-s1@1", Areas.locate(LatLng(17.43 + f * 0.02, 78.4 + f * 0.02), areas).key)
        }
    }
}
