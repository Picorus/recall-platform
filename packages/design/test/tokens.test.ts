import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/contrast.ts';
import { tokensCss } from '../src/css.ts';
import {
  coreColors,
  fontFamilies,
  googleFontsUrl,
  motion,
  px,
  radii,
  shadows,
  spacing,
  textStyles,
  themedColors,
  themeNames,
  themes,
  type ThemedColorName,
  type ThemeName,
} from '../src/tokens.ts';

const HEX = /^#[0-9A-F]{6}$/;
const core = Object.fromEntries(coreColors.map((t) => [t.name, t.value])) as Record<string, string>;

describe('colours', () => {
  it('are all #RRGGBB', () => {
    for (const token of coreColors) expect(token.value).toMatch(HEX);
    for (const token of themedColors) {
      for (const theme of themeNames) expect(token.value[theme]).toMatch(HEX);
    }
  });

  it('every token has a usage note', () => {
    for (const token of [
      ...coreColors,
      ...themedColors,
      ...spacing,
      ...radii,
      ...shadows,
      ...motion,
    ]) {
      expect(token.usage.length, token.name).toBeGreaterThan(10);
    }
  });

  it('brand fills are volt and text on them is midnight in both themes', () => {
    for (const theme of themeNames) {
      expect(themes[theme].brand).toBe(core.volt);
      expect(themes[theme]['on-brand']).toBe(core.midnight);
    }
  });

  it('an alias always equals the core colour it names', () => {
    for (const token of themedColors as readonly {
      alias?: string;
      value: Record<string, string>;
    }[]) {
      if (!token.alias) continue;
      for (const theme of themeNames) expect(token.value[theme]).toBe(core[token.alias]);
    }
  });

  it('dark page ground is midnight; light page ground is paper', () => {
    expect(themes.dark['surface-0']).toBe(core.midnight);
    expect(themes.light['surface-0']).toBe(core.paper);
  });
});

// Contrast promises from docs/NIGHT_SIGNAL.md and the brand book's usage notes.
type Pair = [fg: ThemedColorName, bg: ThemedColorName, min: number];
const PROMISES: Record<ThemeName, Pair[]> = {
  light: [
    ['ink', 'surface-0', 17],
    ['ink', 'surface-1', 7],
    ['ink-muted', 'surface-0', 7],
    ['ink-muted', 'surface-1', 7],
    ['ink-muted', 'surface-2', 7],
    ['ink-subtle', 'surface-0', 5.6],
    ['ink-subtle', 'surface-1', 5.6],
    ['ink-subtle', 'surface-2', 4.5],
    ['line-strong', 'surface-0', 3],
    ['line-strong', 'surface-1', 3],
    ['line-strong', 'surface-2', 3],
    ['on-brand', 'brand', 15.3],
    ['brand-ink', 'surface-0', 5.6],
    ['brand-ink', 'brand-soft', 4.5],
    ['ink', 'brand-soft', 7],
    ['data', 'surface-0', 4.5],
    ['go', 'surface-0', 4.5],
    ['go', 'surface-1', 4.5],
    ['stop', 'surface-0', 4.5],
    ['stop', 'surface-1', 4.5],
    ['focus', 'surface-0', 3],
  ],
  dark: [
    ['ink', 'surface-0', 17],
    ['ink', 'surface-1', 7],
    ['ink-muted', 'surface-0', 7],
    ['ink-muted', 'surface-1', 7],
    ['ink-muted', 'surface-2', 7],
    ['ink-subtle', 'surface-0', 5.6],
    ['ink-subtle', 'surface-1', 5.6],
    ['ink-subtle', 'surface-2', 4.5],
    ['line-strong', 'surface-0', 3],
    ['line-strong', 'surface-1', 3],
    ['line-strong', 'surface-2', 3],
    ['on-brand', 'brand', 15.3],
    ['brand-ink', 'surface-0', 4.5],
    ['brand-ink', 'brand-soft', 4.5],
    ['ink', 'brand-soft', 7],
    ['data', 'surface-0', 5.5],
    ['go', 'surface-0', 4.5],
    ['go', 'surface-1', 4.5],
    ['stop', 'surface-0', 4.5],
    ['stop', 'surface-1', 4.5],
    ['focus', 'surface-0', 3],
  ],
};

describe.each(themeNames)('%s theme contrast', (theme) => {
  it.each(PROMISES[theme])('%s on %s is at least %d : 1', (fg, bg, min) => {
    const ratio = contrastRatio(themes[theme][fg], themes[theme][bg]);
    expect(Math.round(ratio * 10) / 10).toBeGreaterThanOrEqual(min);
  });
});

describe('contrast maths', () => {
  it('matches known values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});

describe('type', () => {
  it('uses Instrument Sans and Serif, Anek for Indian scripts and IBM Plex Mono, never Inter or Space Grotesk', () => {
    const all = [...Object.values(fontFamilies), googleFontsUrl].join(' ');
    expect(all).not.toMatch(/"Inter"|family=Inter\b|Space Grotesk|Space\+Grotesk/);
    expect(fontFamilies.display).toMatch(/^"Instrument Serif"/);
    expect(fontFamilies.body).toMatch(/^"Instrument Sans", "Anek Telugu", "Anek Devanagari"/);
    expect(fontFamilies.mono).toMatch(/^"IBM Plex Mono"/);
  });

  it('loads every family it names', () => {
    for (const family of [
      'Instrument+Sans',
      'Instrument+Serif',
      'Anek+Telugu',
      'Anek+Devanagari',
      'IBM+Plex+Mono',
    ]) {
      expect(googleFontsUrl).toContain(`family=${family}`);
    }
  });

  it('every style has a unique name, a px size and a sample', () => {
    const styles = textStyles.flatMap((group) => group.styles);
    expect(new Set(styles.map((s) => s.name)).size).toBe(styles.length);
    for (const style of styles) {
      expect(style.fontSize).toMatch(/^\d+px$/);
      expect(style.sample.length).toBeGreaterThan(0);
    }
  });

  it('the serif is kept for big brand headlines: display styles only, and 48px or larger', () => {
    for (const group of textStyles) {
      for (const style of group.styles) {
        if (group.family === 'display')
          expect(Number.parseInt(style.fontSize, 10)).toBeGreaterThanOrEqual(48);
      }
    }
    expect(textStyles.find((g) => g.family === 'display')?.styles.map((s) => s.name)).toEqual([
      'display-xl',
      'display-l',
    ]);
  });
});

describe('shape', () => {
  it('corners are 6 / 10 / 16 / 24 / pill', () => {
    expect(radii.map((r) => r.value)).toEqual([6, 10, 16, 24, 999]);
    expect(px('radius-sm')).toBe(10);
    expect(px('radius-md')).toBe(16);
  });

  it('depth comes in three steps, each for light and dark', () => {
    expect(shadows.map((s) => s.name)).toEqual(['shadow-rest', 'shadow-hover', 'shadow-lift']);
  });
});

describe('motion', () => {
  it('durations stay short and every easing is a cubic-bezier', () => {
    for (const token of motion) {
      if (token.name.startsWith('duration-')) {
        expect(Number.parseInt(token.value, 10), token.name).toBeLessThanOrEqual(600);
      } else expect(token.value, token.name).toMatch(/^cubic-bezier\(/);
    }
  });

  it('spacing is the 8-point grid with a 4 px half step', () => {
    expect(spacing.map((s) => s.value)).toEqual([4, 8, 16, 24, 32, 48, 64, 96]);
    for (const step of spacing) expect(step.value % 4).toBe(0);
  });
});

describe('tokens.css', () => {
  it('is up to date (run `pnpm --filter @recall/design build` if this fails)', () => {
    const committed = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    expect(committed).toBe(tokensCss());
  });

  it('switches every themed token for dark mode both ways', () => {
    const css = tokensCss();
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(":root:not([data-theme='light'])");
    expect(css).toContain("[data-theme='dark']");
    expect(css.match(/--surface-0:/g)).toHaveLength(3);
    expect(css.match(/--shadow-lift:/g)).toHaveLength(3);
  });

  it('declares every variable components.css uses', () => {
    const css = tokensCss();
    const components = readFileSync(new URL('../components.css', import.meta.url), 'utf8');
    const used = new Set([...components.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
    for (const name of used) expect(css, name).toContain(`${name}:`);
  });
});
