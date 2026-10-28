// Turns the tokens into CSS custom properties for the web apps (packages/design/tokens.css).
// Names match the RECALL design system's own tokens.css, so components.css works in both places.
import {
  coreColors,
  fontFamilies,
  lineWidth,
  motion,
  radii,
  shadows,
  spacing,
  themedColors,
  type ThemeName,
} from './tokens.ts';

function themeVars(theme: ThemeName, indent: string): string {
  return [...themedColors, ...shadows]
    .map((token) => `${indent}--${token.name}: ${token.value[theme]};`)
    .join('\n');
}

/** The full stylesheet: light by default, dark from the system setting or data-theme="dark". */
export function tokensCss(): string {
  const fixed = [
    ...coreColors.map((token) => `--${token.name}: ${token.value};`),
    ...Object.entries(fontFamilies).map(([name, stack]) => `--font-${name}: ${stack};`),
    ...spacing.map((token) => `--${token.name}: ${token.value}px;`),
    ...radii.map((token) => `--${token.name}: ${token.value}px;`),
    `--line-width: ${lineWidth}px;`,
    ...motion.map((token) => `--${token.name}: ${token.value};`),
  ]
    .map((line) => `  ${line}`)
    .join('\n');

  return `/* Generated from packages/design/src/tokens.ts by \`pnpm --filter @recall/design build\`. Do not edit. */

:root {
${fixed}
}

:root,
[data-theme='light'] {
${themeVars('light', '  ')}
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${themeVars('dark', '    ')}
    color-scheme: dark;
  }
}

[data-theme='dark'] {
${themeVars('dark', '  ')}
  color-scheme: dark;
}
`;
}
