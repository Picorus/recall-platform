# TextField

A labelled input or select with helper or error text, 44px tall, 6px corners (`radius-sm`).

**Consumer provides:** a visible label (never a placeholder alone), and helper or error text where it helps.

**Do:** the border is `line-strong` (3:1+ on every surface); figures use `rc-input--number` (mono, right-aligned); an error sets `aria-invalid="true"`, a 2px `stop` border and a message that starts with a word ("Error: book at least 5 bikes."); 2px `focus` ring on keyboard focus.

**Don't:** show an error by colour alone, or disable a field without saying why.

**In code:** `rc-field`, `rc-field__label`, `rc-input`, `rc-field__help`, `rc-field__error` from `@recall/design/components.css`.
