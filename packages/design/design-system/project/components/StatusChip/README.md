# StatusChip

A pill that shows a state with a dot and a word: Moving, Paused, Offline, Check failed.

**Consumer provides:** the state and its word.

**Do:** always include the word; use `go` for moving and paid, volt for paused (text in `brand-ink`), `ink-subtle` for offline, `stop` for errors.

**Don't:** rely on the dot's colour alone, or use chips as buttons.

**In code:** `<span class="rc-chip rc-chip--go"><i class="rc-chip__dot"></i>Moving</span>` (also `--paused`, `--offline`, `--stop`) from `@recall/design/components.css`.
