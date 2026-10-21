# ChartColours

Chart series colours, in order: 1 `brand-ink` (light) / `brand` (dark), 2 `data`, 3 `ink-muted`.

**Consumer provides:** the series in a fixed order and a name for each.

**Do:** keep the mapping everywhere so people learn it: RECALL's own figure is series 1, the rider's share is always `data`. Name every series on the chart itself (a key or a label at the end of each line).

**Don't:** tell series apart by colour alone. In light, series 1 and 2 are close in lightness (1.1:1); the names carry the meaning. No gradients, no fourth colour.

**In code:** `chartSeries` and `resolve()` from `@recall/design`.
