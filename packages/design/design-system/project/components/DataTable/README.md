# DataTable

A table of figures: bookings, plays, payouts, invoices.

**Consumer provides:** column headers, and which columns hold figures.

**Do:** headers in `label` style; the first column in `ink`, the rest in `ink-muted`; figures in `data` style (IBM Plex Mono 500), right-aligned, with Indian digit grouping (1,00,000); `rc-table--banded` for long tables; `rc-row--highlight` (`brand-soft`) for the one row that matters; wrap wide tables in `rc-table-wrap` so they scroll inside, never the page.

**Don't:** centre figures, mix units in one column, or show a figure without its unit in the header.

**In code:** `rc-table`, `rc-num`, `rc-table--banded`, `rc-row--highlight`, `rc-table-wrap` from `@recall/design/components.css`.
