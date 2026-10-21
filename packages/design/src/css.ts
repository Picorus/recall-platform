// Turns the tokens into CSS custom properties for the web portals (packages/design/tokens.css).
import { core, fonts, lineWidth, radius, space, textSizes, themes, type Theme } from './tokens.ts';

function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
}

function themeVars(theme: Theme, indent: string): string {
  return Object.entries(theme)
    .map(([name, value]) => `${indent}--${kebab(name)}: ${value};`)
    .join('\n');
}

/** The full stylesheet: light by default, dark from the system setting or data-theme="dark". */
export function tokensCss(): string {
  const fixed = [
    ...Object.entries(core).map(([name, value]) => `--${name}: ${value};`),
    ...Object.entries(fonts).map(([name, value]) => `--font-${name}: ${value};`),
    ...Object.entries(textSizes).flatMap(([name, { size, lineHeight }]) => [
      `--text-${name}: ${size}px;`,
      `--leading-${name}: ${lineHeight}px;`,
    ]),
    ...Object.entries(space).map(([step, px]) => `--space-${step}: ${px}px;`),
    ...Object.entries(radius).map(([name, px]) => `--radius-${name}: ${px}px;`),
    `--line-width: ${lineWidth}px;`,
  ]
    .map((line) => `  ${line}`)
    .join('\n');

  return `/* Generated from packages/design/src/tokens.ts by \`pnpm --filter @recall/design build\`. Do not edit. */

:root {
${fixed}
${themeVars(themes.light, '  ')}
  color-scheme: light;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${themeVars(themes.dark, '    ')}
    color-scheme: dark;
  }
}

:root[data-theme='dark'] {
${themeVars(themes.dark, '  ')}
  color-scheme: dark;
}
`;
}
