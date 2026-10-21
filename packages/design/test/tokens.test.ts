import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/contrast.ts';
import { tokensCss } from '../src/css.ts';
import { core, fonts, googleFontsUrl, radius, space, themes, type Theme } from '../src/tokens.ts';

const HEX = /^#[0-9A-F]{6}$/;

describe('colours', () => {
  it('are all #RRGGBB', () => {
    for (const value of [
      ...Object.values(core),
      ...Object.values(themes.light),
      ...Object.values(themes.dark),
    ]) {
      expect(value).toMatch(HEX);
    }
  });

  it('light and dark define the same tokens', () => {
    expect(Object.keys(themes.dark).sort()).toEqual(Object.keys(themes.light).sort());
  });

  it('brand fills are volt and text on them is midnight in both themes', () => {
    for (const theme of Object.values(themes)) {
      expect(theme.brand).toBe(core.volt);
      expect(theme.onBrand).toBe(core.midnight);
    }
  });

  it('dark page ground is midnight; light page ground is paper', () => {
    expect(themes.dark.surface0).toBe(core.midnight);
    expect(themes.light.surface0).toBe(core.paper);
  });
});

// Contrast promises from docs/NIGHT_SIGNAL.md (and WCAG minimums where it gives none).
type Pair = [fg: keyof Theme, bg: keyof Theme, min: number];
const PROMISES: Record<'light' | 'dark', Pair[]> = {
  light: [
    ['ink', 'surface0', 17],
    ['ink', 'surface1', 7],
    ['inkMuted', 'surface0', 7],
    ['inkMuted', 'surface1', 7],
    ['inkSubtle', 'surface0', 5.6],
    ['inkSubtle', 'surface1', 5.6],
    ['lineStrong', 'surface0', 3],
    ['lineStrong', 'surface1', 3],
    ['lineStrong', 'surface2', 3],
    ['onBrand', 'brand', 15.3],
    ['brandInk', 'surface0', 5.6],
    ['data', 'surface0', 4.5],
    ['go', 'surface0', 4.5],
    ['stop', 'surface0', 4.5],
    ['focus', 'surface0', 3],
  ],
  dark: [
    ['ink', 'surface0', 17],
    ['ink', 'surface1', 7],
    ['inkMuted', 'surface0', 7],
    ['inkMuted', 'surface1', 7],
    ['inkSubtle', 'surface0', 5.6],
    ['inkSubtle', 'surface1', 5.6],
    ['lineStrong', 'surface0', 3],
    ['lineStrong', 'surface1', 3],
    ['lineStrong', 'surface2', 3],
    ['onBrand', 'brand', 15.3],
    ['brandInk', 'surface0', 4.5],
    ['data', 'surface0', 5.5],
    ['go', 'surface0', 4.5],
    ['stop', 'surface0', 4.5],
    ['focus', 'surface0', 3],
  ],
};

describe.each(['light', 'dark'] as const)('%s theme contrast', (name) => {
  it.each(PROMISES[name])('%s on %s is at least %d : 1', (fg, bg, min) => {
    const ratio = contrastRatio(themes[name][fg], themes[name][bg]);
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
  it('uses Anek and IBM Plex Mono, never Inter or Space Grotesk', () => {
    const all = [...Object.values(fonts), googleFontsUrl].join(' ');
    expect(all).not.toMatch(/Inter\b|Space Grotesk|Space\+Grotesk/);
    expect(fonts.sans).toMatch(/^'Anek Latin'/);
    expect(fonts.mono).toMatch(/^'IBM Plex Mono'/);
  });

  it('loads every family it names', () => {
    for (const family of ['Anek+Latin', 'Anek+Telugu', 'Anek+Devanagari', 'IBM+Plex+Mono']) {
      expect(googleFontsUrl).toContain(`family=${family}`);
    }
  });
});

describe('shape', () => {
  it('corners are 6 / 14 / 20 / pill', () => {
    expect(radius).toEqual({ control: 6, card: 14, hero: 20, pill: 999 });
  });

  it('spacing sits on the 4 px grid', () => {
    for (const [step, px] of Object.entries(space)) {
      expect(px).toBe(Number(step) * 4);
    }
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
    expect(css).toContain(":root[data-theme='dark']");
    expect(css.match(/--surface-0:/g)).toHaveLength(3);
  });
});
