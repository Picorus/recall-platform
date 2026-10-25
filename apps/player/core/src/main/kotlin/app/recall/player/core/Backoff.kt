// P2.3: when to try the line again. After a drop the screen retries at once-ish, then waits longer
// each time (1, 2, 4 … up to 60 seconds), with a random part so a thousand screens coming back after
// a network outage do not all knock at the same second. A line that stayed up a minute starts over.
package app.recall.player.core

data class BackoffRules(
    val firstMs: Long = 1_000,
    val longestMs: Long = 60_000,
    /** A line up at least this long counts as good: the next drop starts from the first wait. */
    val stableMs: Long = 60_000,
) {
    init {
        require(firstMs > 0 && longestMs >= firstMs && stableMs > 0)
    }
}

/** Failed tries in a row, and when the line last came up (monotonic ms). Immutable, so testable. */
data class Backoff(val tries: Int = 0, val upSince: Long? = null) {
    /**
     * The wait before the next try, and the new state. `random(n)` gives a whole number 0 until n
     * (crypto or plain random on the box; fixed in tests).
     */
    fun failed(rules: BackoffRules = BackoffRules(), random: (Long) -> Long): Pair<Long, Backoff> {
        val ceiling = minOf(rules.longestMs, rules.firstMs shl minOf(tries, 20))
        // Somewhere in the top half of the ceiling: never zero, never all at once.
        val wait = ceiling / 2 + random(ceiling - ceiling / 2 + 1)
        return wait to Backoff(tries + 1, null)
    }

    /** The line came up. */
    fun connected(nowMs: Long) = copy(upSince = nowMs)

    /** The line dropped: a line that was up long enough forgets the earlier failures. */
    fun dropped(nowMs: Long, rules: BackoffRules = BackoffRules()) =
        if (upSince != null && nowMs - upSince >= rules.stableMs) Backoff() else copy(upSince = null)
}
