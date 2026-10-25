// P2.6.3: the screen's local scheduler (plan: "knows its area from GPS, follows the cloud's
// assignment, falls back to its own pick from the hour plan when offline"). It keeps what the cloud
// sends (P2.6.2) and answers playback's question for any moment: which plan, and what does this bike
// carry? (PlanSource, P2.5.)
//  - The area is the one the tracker settled on (P2.6.1, with its 15-second hold). Inside an area,
//    the bike carries that area's booking. In an area's edge zone only if it was inside that area
//    earlier this hour (so GPS wobbling along a border never switches the brand); a bike that just
//    stays near an area carries nothing (edge plays count only up to a share of a line, P1.5.3, and
//    the cloud only assigns bikes inside). Outside every area: no plan, RECALL's own ads.
//  - In an area-hour with the cloud's assignment, the bike carries that (the newest for that
//    area-hour, kept: a bike coming back carries the same again). Without one, or for a part of it
//    the plan the box holds does not know, the screen's own pick (P1.4.3).
// Everything is kept on storage, so a box that starts with no signal still knows its areas, plans and
// assignments. What has ended is dropped by the newest cloud time seen, never the box's own clock; a
// message dated well ahead of the trusted time is refused (one bad time must not freeze later ones).
// Playback reads a finished copy of the state without waiting: saving a large plan never delays a spot.
package app.recall.player.core

import java.io.File
import java.util.concurrent.atomic.AtomicLong
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

class LocalScheduler(
    private val dir: File,
    private val screenId: String,
    /** Trusted time now (UTC ms), or null while there is none (TrustedClock). */
    private val nowMs: () -> Long? = { null },
    private val log: (String) -> Unit = {},
) : PlanSource, WhereSource {
    /** Everything playback needs, never changed once made (a new one replaces it whole). */
    private data class State(
        val areas: AreaList = AreaList(0, emptyList()),
        /** Per area-hour ("area|startsAt"). */
        val plans: Map<String, HourPlan> = emptyMap(),
        val plansMade: Long = 0,
        val assigned: Map<String, Pair<Assignment, String>> = emptyMap(),
    )

    @Volatile private var state = State()
    @Volatile private var place: Place = Place.Outside
    /** Area-hours this bike has been inside (so it may keep carrying there in the edge zone). */
    private val wasInside = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val writing = Any()
    /** Where the bike was, second by second, for the last couple of minutes (play records, P2.7). */
    private val seen = java.util.concurrent.ConcurrentSkipListMap<Long, Where>()

    private val refusedCount = AtomicLong()
    private val unmatchedCount = AtomicLong()
    /** Messages from the cloud refused (bad, or dated ahead). Should stay 0; health, P2.11. */
    val refused: Long get() = refusedCount.get()
    /** Spots where the cloud's assignment named a line or spot the box's plan does not have. */
    val unmatched: Long get() = unmatchedCount.get()

    init {
        dir.mkdirs()
        load()
    }

    private fun key(areaId: String, startsAt: Long) = "$areaId|$startsAt"

    private fun load() {
        var s = State()
        file("areas")?.let { text -> PlanMessages.areas(text).let { if (it.problem == null) s = s.copy(areas = it) else log("schedule: kept areas refused: ${it.problem}") } }
        file("plans")?.let { text ->
            val list = PlanMessages.plans(text)
            if (list.problem == null) {
                s = s.copy(plans = list.plans.associateBy { key(it.areaId, it.startsAt) }, plansMade = list.made)
            } else {
                log("schedule: kept plans refused: ${list.problem}")
            }
        }
        file("assigned")?.let { text ->
            val kept = HashMap<String, Pair<Assignment, String>>()
            runCatching { Json.parseToJsonElement(text) as JsonArray }.getOrNull()?.forEach { e ->
                val raw = (e as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@forEach
                val a = PlanMessages.assign(raw)
                if (a.problem == null) kept[key(a.areaId, a.startsAt)] = a to raw
            }
            s = s.copy(assigned = kept)
        }
        state = s
    }

    private fun file(name: String) = File(dir, name).takeIf { it.exists() }?.let { runCatching { it.readText() }.getOrNull() }

    private fun refuse(kind: String, problem: String): Boolean {
        refusedCount.incrementAndGet()
        log("schedule: $kind refused: $problem")
        return false
    }

    /** Dated more than a few minutes ahead of the trusted time (without one, nothing is ahead). */
    private fun ahead(made: Long): Boolean = nowMs()?.let { made > it + AHEAD_MS } ?: false

    /** The city's areas (down/areas): the newest list wins. Returns true when taken. */
    fun onAreas(text: String): Boolean {
        val a = PlanMessages.areas(text) // read before the lock: playback is never held up
        if (a.problem != null) return refuse("areas", a.problem)
        if (ahead(a.made)) return refuse("areas", "dated ahead")
        synchronized(writing) {
            if (a.made < state.areas.made) return false
            DiskFiles.writeAtomically(File(dir, "areas"), text)
            state = state.copy(areas = a)
        }
        return true
    }

    /** Hour plans (down/plan): per area-hour the highest revision wins. Returns true when any was taken. */
    fun onPlans(text: String): Boolean {
        val list = PlanMessages.plans(text)
        if (list.problem != null) return refuse("plans", list.problem)
        if (ahead(list.made)) return refuse("plans", "dated ahead")
        synchronized(writing) {
            val s = state
            val plans = HashMap(s.plans)
            var taken = false
            for (p in list.plans) {
                val k = key(p.areaId, p.startsAt)
                val old = plans[k]
                if (old == null || p.revision > old.revision) {
                    plans[k] = p
                    taken = true
                }
            }
            // Hours that ended before the newest cloud time seen are of no more use.
            val made = maxOf(s.plansMade, list.made)
            plans.values.removeAll { it.startsAt + HOUR <= made / 1000 }
            if (plans.size > PlanMessages.MAX_PLANS) {
                // Never more than the box can read back: the hours furthest ahead wait for a re-send.
                plans.values.sortedBy { it.startsAt }.drop(PlanMessages.MAX_PLANS).forEach { p -> plans.remove(key(p.areaId, p.startsAt)) }
            }
            val assigned = s.assigned.filterValues { (a, _) -> a.startsAt + HOUR > made / 1000 }
            val kept = PlanMessages.plansText(plans.values.sortedBy { key(it.areaId, it.startsAt) }, made)
            check(PlanMessages.plans(kept).problem == null) { "the plans kept would not read back" }
            DiskFiles.writeAtomically(File(dir, "plans"), kept)
            saveAssigned(assigned)
            state = s.copy(plans = plans, plansMade = made, assigned = assigned)
            wasInside.removeIf { k -> k.substringAfterLast('|').toLong() + HOUR <= made / 1000 }
            return taken
        }
    }

    /** The cloud's pick for this screen (down/assign): per area-hour the newest wins. Returns true when taken. */
    fun onAssign(text: String): Boolean {
        val a = PlanMessages.assign(text)
        if (a.problem != null) return refuse("assignment", a.problem)
        if (ahead(a.made)) return refuse("assignment", "dated ahead")
        synchronized(writing) {
            val s = state
            val k = key(a.areaId, a.startsAt)
            val old = s.assigned[k]
            if (old != null && old.first.made >= a.made) return false
            val newest = maxOf(s.plansMade, a.made) / 1000
            val assigned = (s.assigned + (k to (a to text))).filterValues { (x, _) -> x.startsAt + HOUR > newest }
            saveAssigned(assigned)
            state = s.copy(assigned = assigned)
            return true
        }
    }

    private fun saveAssigned(assigned: Map<String, Pair<Assignment, String>>) = DiskFiles.writeAtomically(
        File(dir, "assigned"),
        JsonArray(assigned.entries.sortedBy { it.key }.map { JsonPrimitive(it.value.second) }).toString(),
    )

    /** What the tracker settled on this second (P2.6.1). */
    fun onSecond(second: Second) {
        val p = second.place
        place = p
        seen[second.t] = Where.of(second.position, second.accuracyM, p)
        seen.headMap(second.t - KEEP_SECONDS).clear()
        if (p is Place.Inside) planFor(state, p.areaId, second.t * 1000)?.let { wasInside += key(p.areaId, it.startsAt) }
    }

    /**
     * Where the bike was at `utcSecond`: that second's position and area (no position without a good
     * fix that second). Without a second from the tracker then, no position, the area as it is now.
     */
    override fun where(utcSecond: Long): Where = seen[utcSecond] ?: Where.unknown(place.key)

    /** The areas in force, for the tracker. */
    fun areas(): List<AreaVersion> = state.areas.areas

    /** The plan for the hour holding `utcMs` in an area (one per hour; the latest start if ever two). */
    private fun planFor(s: State, areaId: String, utcMs: Long): HourPlan? =
        s.plans.values.filter { it.areaId == areaId && utcMs >= it.startsAt * 1000 && utcMs < (it.startsAt + HOUR) * 1000 }
            .maxByOrNull { it.startsAt }

    /** The plan and what this bike carries at `utcMs`; null outside every area or without a plan. */
    override fun at(utcMs: Long): Pair<HourPlan, Carry>? {
        val s = state
        val (areaId, edge) = when (val p = place) {
            is Place.Inside -> p.areaId to false
            is Place.Edge -> p.areaId to true
            Place.Outside -> return null
        }
        val plan = planFor(s, areaId, utcMs) ?: return null
        val k = key(areaId, plan.startsAt)
        if (edge && k !in wasInside) return null
        val own by lazy { Fallback.pick(plan, screenId) }
        val given = s.assigned[k]?.first?.carry ?: return plan to own
        // A part of the assignment the plan held here does not know (a newer revision not yet here):
        // the screen's own pick for that part, so the bike never plays nothing by mistake.
        val line = given.lineId?.takeIf { id -> plan.lines.none { it.lineId == id } }
        val spot = given.spotId?.takeIf { id -> plan.spotDemands.none { it.id == id } }
        if (line == null && spot == null) return plan to given
        unmatchedCount.incrementAndGet()
        return plan to Carry(if (line != null) own.lineId else given.lineId, if (spot != null) own.spotId else given.spotId)
    }

    private companion object {
        const val HOUR = 3600L
        /** Seconds of positions kept for play records (a play is recorded when its spot ends). */
        const val KEEP_SECONDS = 120L
        /** How far ahead of the trusted time a cloud message may be dated (the cloud's clock may be a little ahead). */
        const val AHEAD_MS = 5 * 60_000L
    }
}
