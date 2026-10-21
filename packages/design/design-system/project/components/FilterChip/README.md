# FilterChip

A selectable pill for filters: areas, days, campaign states.

**Consumer provides:** a short word or two, and whether it is selected (`aria-pressed`).

**Do:** group related chips (`role="group"` with a label); a selected chip gets the `brand-soft` wash, a `brand-ink` border and a tick, so it never depends on colour alone; 32px tall at least.

**Don't:** use filter chips for actions (that is a Button), or put more than about 8 in a row.

**In code:** `<button class="rc-chip" aria-pressed="true">` with `@recall/design/components.css`.
