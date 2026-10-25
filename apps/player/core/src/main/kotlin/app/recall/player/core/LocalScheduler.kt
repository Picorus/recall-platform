// P2.6.3: the screen's local scheduler (plan: "knows its area from GPS, follows the cloud's
// assignment, falls back to its own pick from the hour plan when offline"). It keeps what the cloud
// sends (P2.6.2) and answers playback's question for any moment: which plan, and what does this bike
// carry? (PlanSource, P2.5.)
//  - The area is the one the tracker settled on (P2.6.1, with its 15-second hold): inside an area or
//    in its edge zone (plays there count for the area, up to a share, P1.5.3). Outside every area:
//    no plan, RECALL's own ads.
//  - In an area-hour with the cloud's assignment, the bike carries that (the newest for that
//    area-hour, kept: a bike coming back into an area carries the same again). Without one, the
//    screen's own pick from the plan (P1.4.3), the same the cloud would expect.
// Everything is kept on storage, so a box that starts with no signal still knows its areas, plans and
// assignments. What has ended is dropped by the cloud's own times (the messages'), never the box's.
package app.recall.player.core

import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

class LocalScheduler(
    private val dir: File,
    private val screenId: String,
    private val log: (String) -> Unit = {},
) : PlanSource {
    @Volatile private var place: Place = Place.Outside
    private var areas = AreaList(0, emptyList())
    private val plans = HashMap<String, HourPlan>()
    private var plansMade = 0L
    private val assigned = HashMap<String, Pair<Assignment, String>>()
    private val refusedCount = AtomicLong()

    /** Messages from the cloud refused whole (should stay 0; health, P2.11). */
    val refused: Long get() = refusedCount.get()

    init {
        dir.mkdirs()
        load()
    }

    private fun key(areaId: String, startsAt: Long) = "$areaId|$startsAt"

    private fun load() {
        file("areas")?.let { text -> PlanMessages.areas(text).takeIf { it.problem == null }?.let { areas = it } }
        file("plans")?.let { text ->
            PlanMessages.plans(text).takeIf { it.problem == null }?.let { list ->
                plansMade = list.made
                list.plans.forEach { plans[key(it.areaId, it.startsAt)] = it }
            }
        }
        file("assigned")?.let { text ->
            runCatching { Json.parseToJsonElement(text) as JsonArray }.getOrNull()?.forEach { e ->
                val raw = (e as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@forEach
                val a = PlanMessages.assign(raw)
                if (a.problem == null) assigned[key(a.areaId, a.startsAt)] = a to raw
            }
        }
    }

    private fun file(name: String) = File(dir, name).takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() }

    private fun refuse(kind: String, problem: String): Boolean {
        refusedCount.incrementAndGet()
        log("schedule: $kind refused: $problem")
        return false
    }

    /** The city's areas (down/areas): the newest list wins. Returns true when taken. */
    @Synchronized
    fun onAreas(text: String): Boolean {
        val a = PlanMessages.areas(text)
        if (a.problem != null) return refuse("areas", a.problem)
        if (a.made < areas.made) return false
        areas = a
        DiskFiles.writeAtomically(File(dir, "areas"), text)
        return true
    }

    /** Hour plans (down/plan): per area-hour the highest revision wins. Returns true when any was taken. */
    @Synchronized
    fun onPlans(text: String): Boolean {
        val list = PlanMessages.plans(text)
        if (list.problem != null) return refuse("plans", list.problem)
        var taken = false
        for (p in list.plans) {
            val k = key(p.areaId, p.startsAt)
            val old = plans[k]
            if (old == null || p.revision > old.revision) {
                plans[k] = p
                taken = true
            }
        }
        plansMade = maxOf(plansMade, list.made)
        // Hours that ended before the cloud wrote this are of no more use.
        val now = list.made / 1000
        plans.values.removeAll { it.startsAt + HOUR <= now }
        assigned.values.removeAll { (a, _) -> a.startsAt + HOUR <= now }
        DiskFiles.writeAtomically(File(dir, "plans"), PlanMessages.plansText(plans.values.sortedBy { key(it.areaId, it.startsAt) }, plansMade))
        saveAssigned()
        return taken
    }

    /** The cloud's pick for this screen (down/assign): per area-hour the newest wins. Returns true when taken. */
    @Synchronized
    fun onAssign(text: String): Boolean {
        val a = PlanMessages.assign(text)
        if (a.problem != null) return refuse("assignment", a.problem)
        val k = key(a.areaId, a.startsAt)
        val old = assigned[k]
        if (old != null && old.first.made >= a.made) return false
        assigned[k] = a to text
        val now = a.made / 1000
        assigned.values.removeAll { (x, _) -> x.startsAt + HOUR <= now }
        saveAssigned()
        return true
    }

    private fun saveAssigned() = DiskFiles.writeAtomically(
        File(dir, "assigned"),
        JsonArray(assigned.values.sortedBy { (a, _) -> key(a.areaId, a.startsAt) }.map { (_, raw) -> JsonPrimitive(raw) }).toString(),
    )

    /** What the tracker settled on this second (P2.6.1). */
    fun onSecond(second: Second) {
        place = second.place
    }

    /** The areas in force, for the tracker. */
    @Synchronized
    fun areas(): List<AreaVersion> = areas.areas

    /** The plan and what this bike carries at `utcMs`; null outside every area or without a plan. */
    @Synchronized
    override fun at(utcMs: Long): Pair<HourPlan, Carry>? {
        val areaId = when (val p = place) {
            is Place.Inside -> p.areaId
            is Place.Edge -> p.areaId
            Place.Outside -> return null
        }
        val plan = plans.values.firstOrNull { it.areaId == areaId && utcMs >= it.startsAt * 1000 && utcMs < (it.startsAt + HOUR) * 1000 }
            ?: return null
        val carry = assigned[key(areaId, plan.startsAt)]?.first?.carry ?: Fallback.pick(plan, screenId)
        return plan to carry
    }

    private companion object {
        const val HOUR = 3600L
    }
}
