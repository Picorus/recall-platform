// Night Signal on the rider app: the dark theme (riders use it outdoors and at night). Colours come
// from the shared tokens (@recall/design); sizes from the approved rider screens (P0.3.4).
import { themes } from '@recall/design';

const dark = themes.dark;

export const color = {
  ground: dark['surface-0'],
  raised: dark['surface-1'],
  field: dark['surface-2'],
  text: dark.ink,
  muted: dark['ink-muted'],
  quiet: dark['ink-subtle'],
  line: dark['line-strong'],
  divider: dark.line,
  volt: dark.brand,
  onVolt: dark['on-brand'],
  error: dark.stop,
  done: dark.go,
  focus: dark.focus,
} as const;

/** Big enough to tap with a glove: never under 44, main buttons 52. */
export const touch = { min: 44, main: 52 } as const;
