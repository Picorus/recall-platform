import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADAPTIVE_SCALE, ICON_SIZE, iconPngs, iconVariants, parseAppIcon } from '../src/icons.ts';
import { coreColors } from '../src/tokens.ts';

const file = (path: string) => new URL(`../brand/${path}`, import.meta.url);
const text = (path: string) => readFileSync(file(path), 'utf8');
const appIcon = text('logo/recall-app-icon.svg');
const brandHex = new Set(['#C8F54A', '#0A0E17', '#F4F5F0']);

function pngSize(path: string): [number, number] {
  const png = readFileSync(file(path));
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('logo files', () => {
  const logos = readdirSync(file('logo')).filter((name) => name.endsWith('.svg'));

  it('has all 11 brand-book files', () => {
    expect(logos).toHaveLength(11);
  });

  it.each(logos)('%s uses only volt, midnight and paper, and loads nothing', (name) => {
    const svg = text(`logo/${name}`);
    for (const hex of svg.match(/#[0-9A-Fa-f]{6}\b/g) ?? [])
      expect(brandHex).toContain(hex.toUpperCase());
    expect(svg).not.toMatch(/<script|href=|on[a-z]+=|url\((?!#)/i);
    expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
  });

  it('the brand colours are the design tokens', () => {
    const core = Object.fromEntries(coreColors.map((t) => [t.name, t.value]));
    expect([...brandHex].sort()).toEqual([core.volt, core.midnight, core.paper].sort());
  });
});

describe('app icons', () => {
  it('derived SVGs are up to date (run `pnpm --filter @recall/design build` if this fails)', () => {
    for (const [name, svg] of Object.entries(iconVariants(appIcon))) {
      expect(text(`icons/${name}`), name).toBe(svg);
    }
    expect(text('icons/web/favicon.svg')).toBe(appIcon);
  });

  it('keeps the Afterimage exactly: volt symbol, midnight ground, three parts', () => {
    const { ground, symbol } = parseAppIcon(appIcon);
    expect(ground).toBe('#0A0E17');
    expect(symbol.map((r) => r.fill)).toEqual(['#C8F54A', '#C8F54A', '#C8F54A']);
    // echoes 78% and 56% of the screen block's height (brand book, Logo)
    const [small, mid, screen] = symbol.map((r) => r.height) as [number, number, number];
    expect(mid / screen).toBeCloseTo(0.78, 2);
    expect(small / screen).toBeCloseTo(0.56, 2);
  });

  it('the adaptive symbol stays inside Android’s 66/108 safe circle', () => {
    const { symbol } = parseAppIcon(appIcon);
    const c = ICON_SIZE / 2;
    const reach = Math.max(
      ...symbol.flatMap((r) =>
        [
          [r.x, r.y],
          [r.x + r.width, r.y + r.height],
          [r.x, r.y + r.height],
          [r.x + r.width, r.y],
        ].map(([x = 0, y = 0]) => Math.hypot(x - c, y - c) * ADAPTIVE_SCALE),
      ),
    );
    expect(reach).toBeLessThan((ICON_SIZE * 33) / 108);
  });

  it.each(iconPngs)('%s is a %s PNG of %i px', (path, _source, size) => {
    expect(pngSize(`icons/${path}`)).toEqual([size, size]);
  });
});
