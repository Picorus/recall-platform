# MapStyle

Map colour roles for the fleet map, area drawing and report heat maps, taken from the themed tokens.

**Roles:** ground `surface-0`; minor roads `line`; main roads `line-strong`; street and area names `ink-subtle` in `label` style; a sold area `data-soft` fill with a `data` outline; a bike's route `data` (dashed); a live bike `brand` with an `on-brand` ring, the one volt thing on the map.

**Heat map:** few to many plays runs `data-soft` → `data` → `ink` in light and `data-soft` → `data` → `brand` in dark, so each step is clearly lighter or darker than the last.

**Consumer provides:** the map library (MapLibre) and the data; the style reads these roles.

**Don't:** use `stop` or any red on maps shown to riders, or add a second bright colour beside volt.

**In code:** `mapRoles`, `heatRamp` and `resolve()` from `@recall/design`. The full MapLibre style is built in P3.
