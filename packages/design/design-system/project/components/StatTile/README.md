# StatTile

A tile for one number: label, value in the `numeral` style, and a short context line.

**Consumer provides:** a label, the value with its unit, and one line of context (period, floor or source).

**Do:** make at most one tile per row the volt hero; use tabular figures and Indian grouping.

**Don't:** show a number without its unit or period, or animate the value more than once.

**In code:** `rc-stat` (and `rc-stat--hero` for the one volt tile), `rc-stat__label`, `rc-stat__value`, `rc-stat__note` from `@recall/design/components.css`.
