# Card

A container for one thing: a booking, a report, a rider. `surface-1`, 1px `line`, 14px corners (`radius-md`), 24px padding (`space-4`).

**Consumer provides:** a `title`, short body text, and at most one action.

**Do:** separate cards with surface and hairline, not shadow; put a status chip or one secondary button at the bottom.

**Don't:** put a shadow on cards in a grid (shadow is for floating layers only), nest cards, or add a coloured left border.

**In code:** `rc-card`, `rc-card__title`, `rc-card__body` from `@recall/design/components.css`.
