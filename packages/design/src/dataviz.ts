// Chart and map colours. Every entry names an existing token, so a colour change happens in one place.
import type { ThemedColorName, ThemeName } from './tokens.ts';
import { themes } from './tokens.ts';

/**
 * Chart series in order (brand book, Colour → Data colours). The rider's share of every ₹100 is
 * always `data`; RECALL's own figure is always series 1. FLAG: in light, series 1 and 2 are close in
 * lightness (1.1:1), so charts always label each series by name, never by colour alone.
 */
export const chartSeries: Readonly<Record<ThemeName, readonly ThemedColorName[]>> = {
  light: ['brand-ink', 'data', 'ink-muted'],
  dark: ['brand', 'data', 'ink-muted'],
};

/** Map roles for MapLibre styles and heat maps (P3 builds the full map style on these). */
export const mapRoles = {
  /** Land / page under the map. */
  ground: 'surface-0',
  /** Minor roads and area borders that only separate. */
  road: 'line',
  /** Main roads. */
  roadMajor: 'line-strong',
  /** Street and area names. */
  label: 'ink-subtle',
  /** A sold area's fill. */
  areaFill: 'data-soft',
  /** A sold area's outline and a bike's route. */
  areaLine: 'data',
  /** A live bike: the one volt thing on the map. */
  bike: 'brand',
} as const satisfies Record<string, ThemedColorName>;

/** Heat map from few plays to many. Each step is clearly lighter (dark) or darker (light) than the last. */
export const heatRamp: Readonly<Record<ThemeName, readonly ThemedColorName[]>> = {
  light: ['data-soft', 'data', 'ink'],
  dark: ['data-soft', 'data', 'brand'],
};

/** Resolves a role list to hex for one theme, e.g. for a chart library. */
export function resolve(theme: ThemeName, names: readonly ThemedColorName[]): string[] {
  return names.map((name) => themes[theme][name]);
}
