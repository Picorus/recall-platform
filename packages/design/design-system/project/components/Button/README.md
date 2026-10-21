# Button

Three button styles: primary (volt), secondary (outlined) and quiet (text), all 44 px tall, 6 px corners (`radius-sm`).

**Consumer provides:** a verb label that says exactly what happens ("Book and pay", not "Submit").

**Do:** one primary button per view; quiet buttons for cancel and back; 2 px `focus` ring on keyboard focus.

**Don't:** put two volt buttons side by side, use icons without labels, or write labels in capitals.

**In code:** `rc-button` with `rc-button--primary`, `--secondary` or `--quiet` from `@recall/design/components.css`.
