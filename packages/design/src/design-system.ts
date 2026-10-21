// Builds the RECALL design system's tokens.json (the "RECALL" Design System artifact) from the tokens,
// in the list shape that page reads: {name, value, usage} entries per family.
import {
  coreColors,
  fontFamilies,
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
    version: 3,
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
      note: 'Night Signal corners: 6px on controls, 14px on cards, 20px on hero panels and screen frames, pills for status only.',
      tokens: radii.map(({ name, value, usage }) => ({ name, value: `${value}px`, usage })),
    },
    shadow: {
      note: 'Flat by default. Separation comes from surface steps and hairlines; one lift shadow for floating layers only.',
      tokens: shadows.map(({ name, value, usage }) => ({ name, value, usage })),
    },
  };
}

export function designSystemTokensJson(): string {
  return `${JSON.stringify(designSystemTokens(), null, 2)}\n`;
}
