// P7.7.7: the small charts' styles use only the design tokens (so light and dark both work) and
// never a fixed colour.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tokensCss } from '../src/css.ts';

const charts = readFileSync(new URL('../charts.css', import.meta.url), 'utf8');

describe('charts.css', () => {
  it('declares every token it uses (its own --rc-chart-* aside)', () => {
    const css = tokensCss();
    const used = new Set(
      [...charts.matchAll(/var\((--[a-z0-9-]+)/g)]
        .map((m) => m[1] ?? '')
        .filter((n) => !n.startsWith('--rc-chart-')),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(css, name).toContain(`${name}:`);
  });

  it('has no fixed colours: every colour is a token (or the system colours for forced colours)', () => {
    const noComments = charts.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(noComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(noComments).not.toMatch(/rgba?\(/);
  });

  it('is published next to components.css', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports['./charts.css']).toBe('./charts.css');
  });
});
