import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance } from '../src/contrast.ts';
import { chartSeries, heatRamp, mapRoles, resolve } from '../src/dataviz.ts';
import { themeNames, themes } from '../src/tokens.ts';

describe.each(themeNames)('%s charts and maps', (theme) => {
  const grounds = [themes[theme]['surface-0'], themes[theme]['surface-1']];

  it('every chart series stands out from the page and cards (3:1+)', () => {
    for (const colour of resolve(theme, chartSeries[theme])) {
      for (const ground of grounds) expect(contrastRatio(colour, ground)).toBeGreaterThanOrEqual(3);
    }
  });

  it('heat map steps only get lighter (dark) or darker (light)', () => {
    const levels = resolve(theme, heatRamp[theme]).map(luminance);
    const sorted = [...levels].sort((a, b) => (theme === 'dark' ? a - b : b - a));
    expect(levels).toEqual(sorted);
    for (let i = 1; i < levels.length; i++) {
      const [a = 0, b = 0] = [levels[i - 1], levels[i]];
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('the live bike and routes show on the map ground', () => {
    const ground = themes[theme][mapRoles.ground];
    expect(contrastRatio(themes[theme][mapRoles.areaLine], ground)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(themes[theme][mapRoles.roadMajor], ground)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(themes[theme][mapRoles.label], ground)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('chart series 1 and 2 in light (known: told apart by name, not lightness)', () => {
  it('stays flagged until the colours change', () => {
    const [one = '', two = ''] = resolve('light', chartSeries.light);
    expect(contrastRatio(one, two)).toBeLessThan(1.5);
  });
});
