import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { designSystemTokens, designSystemTokensJson } from '../src/design-system.ts';

const root = new URL('../design-system/project/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

interface Entry {
  name: string;
  value: unknown;
  usage?: string;
}
const tokens = designSystemTokens() as {
  color: { themes: { id: string }[]; tokens: Entry[] };
  spacing: { tokens: Entry[] };
  radius: { tokens: Entry[] };
  shadow: { tokens: Entry[] };
  type: {
    families: Record<string, string>;
    groups: { family: string; styles: { name: string }[] }[];
  };
};

describe('design system tokens.json (the shape the RECALL design-system page reads)', () => {
  it('is up to date (run `pnpm --filter @recall/design build` if this fails)', () => {
    expect(read('tokens.json')).toBe(designSystemTokensJson());
  });

  it('uses lists of {name, value, usage}, with names the page accepts, each used once', () => {
    const all = [
      ...tokens.color.tokens,
      ...tokens.spacing.tokens,
      ...tokens.radius.tokens,
      ...tokens.shadow.tokens,
    ];
    for (const entry of all) {
      expect(entry.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
      expect(entry.usage?.length ?? 0).toBeGreaterThan(0);
    }
    expect(new Set(all.map((e) => e.name)).size).toBe(all.length);
  });

  it('light is the first theme and every colour has a hex value in each theme', () => {
    expect(tokens.color.themes.map((t) => t.id)).toEqual(['light', 'dark']);
    for (const entry of tokens.color.tokens) {
      const values =
        typeof entry.value === 'string' ? [entry.value] : Object.values(entry.value as object);
      for (const value of values) expect(value).toMatch(/^(#[0-9A-F]{6}|\{[a-z-]+\})$/);
    }
  });

  it('every type group names a family that exists', () => {
    for (const group of tokens.type.groups)
      expect(tokens.type.families[group.family]).toBeDefined();
  });

  it('bundle.css is components.css', () => {
    const bundle = read('components/bundle.css');
    const source = readFileSync(new URL('../components.css', import.meta.url), 'utf8');
    expect(bundle.endsWith(source)).toBe(true);
  });
});

describe('component cards', () => {
  const cards = readdirSync(new URL('components/', root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it.each(cards)('%s has a preview with the card marker and a guideline', (card) => {
    const preview = read(`components/${card}/preview.html`);
    expect(preview.split('\n')[0]).toMatch(/^<!-- @dsCard group="[A-Za-z]+" height=\d+ -->$/);
    expect(preview).not.toMatch(/<iframe|<object|<embed/i);
    expect(read(`components/${card}/README.md`)).toMatch(/^# /);
  });

  it.each(cards)('%s uses only classes that components.css defines', (card) => {
    const preview = read(`components/${card}/preview.html`);
    const css = readFileSync(new URL('../components.css', import.meta.url), 'utf8');
    const used = new Set([...preview.matchAll(/\b(rc-[a-z0-9_-]+)/g)].map((m) => m[1]));
    for (const cls of used) expect(css, cls).toContain(`.${cls}`);
  });
});
