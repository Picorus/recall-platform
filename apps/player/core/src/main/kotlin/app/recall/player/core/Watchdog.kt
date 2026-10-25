// P2.2: the watchdog's rules. The player writes a heartbeat every second; a separate watchdog process
// checks it every second and brings the player back within 5 seconds when it stops (plan: "a watchdog
// restarts it within 5 seconds if it crashes"). A player that keeps crashing is restarted with
// growing pauses, so a broken ad file cannot make the box spin, and is flagged for a health alert.
package app.recall.player.core

data class WatchdogRules(
    /** No heartbeat for this long and the player counts as down (it beats every second). */
    val heartbeatTimeoutMs: Long = 3_000,
    /** Restarts inside this window count towards a crash loop. */
    val windowMs: Long = 10 * 60_000,
    /** This many restarts in the window go at once; after that, pauses grow. */
    val quickRestarts: Int = 3,
    /** The first pause after the quick restarts, doubled each time, up to the longest pause. */
    val firstPauseMs: Long = 5_000,
    val longestPauseMs: Long = 60_000,
) {
    init {
        require(heartbeatTimeoutMs in 1_000..4_000) { "the player must be back within 5 seconds" }
        require(quickRestarts >= 1 && firstPauseMs > 0 && longestPauseMs >= firstPauseMs && windowMs > 0)
    }
}

/** What the watchdog should do now. */
sealed interface WatchdogStep {
    /** The player is fine (or a restart is already on its way): check again later. */
    data object Wait : WatchdogStep

    /** Start the player now. `crashLoop`: restarts are too frequent; report it in the health message. */
    data class Restart(val crashLoop: Boolean) : WatchdogStep
}

/** The watchdog's memory: restarts made, and when the next one may happen. Immutable, so testable. */
data class WatchdogState(val restarts: List<Long> = emptyList(), val notBefore: Long = 0) {
    /**
     * One check, at `now`, given the last heartbeat time (null: never seen). Returns the step and the
     * new state.
     */
    fun check(now: Long, lastBeat: Long?, rules: WatchdogRules = WatchdogRules()): Pair<WatchdogStep, WatchdogState> {
        val alive = lastBeat != null && now - lastBeat < rules.heartbeatTimeoutMs
        // A beat after the last restart means it came back: nothing to do.
        if (alive || now < notBefore) return WatchdogStep.Wait to this
        val recent = restarts.filter { now - it < rules.windowMs } + now
        val extra = recent.size - rules.quickRestarts
        val pause = if (extra <= 0) 0L else minOf(rules.longestPauseMs, rules.firstPauseMs shl minOf(extra - 1, 20))
        // After a restart, give the player time to start beating before judging it again.
        val next = WatchdogState(recent, now + maxOf(pause, rules.heartbeatTimeoutMs))
        return WatchdogStep.Restart(crashLoop = extra > 0) to next
    }
}
