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
  voltSoft: dark['brand-soft'],
  data: dark.data,
  dataSoft: dark['data-soft'],
  doneSoft: dark['go-soft'],
  errorSoft: dark['stop-soft'],
} as const;

/** Design 2.0 corners (P7.7): controls, cards, sheets. */
export const radius = { control: 14, card: 18, sheet: 26, pill: 999 } as const;

/** Big enough to tap with a glove: never under 44, main buttons 48. */
export const touch = { min: 44, main: 48 } as const;
