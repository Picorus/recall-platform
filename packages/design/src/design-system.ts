// Builds the RECALL design system's tokens.json (the "RECALL" Design System artifact) from the tokens,
// in the list shape that page reads: {name, value, usage} entries per family.
import {
  coreColors,
  fontFamilies,
  motion,
  radii,
  shadows,
  spacing,
  textStyles,
  themedColors,
  type ThemedValue,
  type Token,
} from './tokens.ts';

export function designSystemTokens(): unknown {
  return {
    name: 'RECALL',
    version: 4,
    meta: { source: 'github.com/Picorus/recall-platform · packages/design/src/tokens.ts' },
    color: {
      themes: [
        { id: 'light', name: 'Paper (light)' },
        { id: 'dark', name: 'Midnight (dark)' },
      ],
      tokens: [
        ...coreColors.map(({ name, value, usage }) => ({ name, value, usage })),
        ...themedColors.map((token: Token<ThemedValue>) => ({
          name: token.name,
          value: token.alias
            ? { light: `{${token.alias}}`, dark: `{${token.alias}}` }
            : token.value,
          usage: token.usage,
        })),
      ],
    },
    type: {
      fonts: [],
      families: fontFamilies,
      groups: textStyles.map((group) => ({
        name: group.name,
        family: group.family,
        // width is a CSS font-stretch hint for code; the page reads it from each style's usage note.
        styles: group.styles.map((style) =>
          Object.fromEntries(Object.entries(style).filter(([key]) => key !== 'width')),
        ),
      })),
    },
    spacing: {
      note: '8-point grid with a 4px half step. Layouts use 8, 16, 24, 32, 48, 64, 96.',
      tokens: spacing.map(({ name, value, usage }) => ({ name, value: `${value}px`, usage })),
    },
    radius: {
      note: 'Design 2.0 corners: 10px on controls, 16px on cards, 24px on sheets and hero panels, pills for chips.',
      tokens: radii.map(({ name, value, usage }) => ({ name, value: `${value}px`, usage })),
    },
    shadow: {
      note: 'Layered depth: rest for cards, hover for what the pointer is on, lift for floating layers only.',
      tokens: shadows.map(({ name, value, usage }) => ({ name, value, usage })),
    },
    motion: {
      note: 'Quick to answer, slow to settle. Nothing moves when the viewer asks for reduced motion.',
      tokens: motion.map(({ name, value, usage }) => ({ name, value, usage })),
    },
  };
}

export function designSystemTokensJson(): string {
  return `${JSON.stringify(designSystemTokens(), null, 2)}\n`;
}
