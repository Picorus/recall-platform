// Night Signal design tokens: the ONE source for every value the apps and the RECALL design system use.
// Colours come from docs/NIGHT_SIGNAL.md; names, type styles, spacing and corners match the RECALL brand book
// (the "RECALL" design-system artifact). Change a value here, then run `pnpm --filter @recall/design build`:
// it rewrites tokens.css (web apps) and the design system's tokens.json. Tests hold the contrast promises.

export type ThemeName = 'light' | 'dark';
export const themeNames: readonly ThemeName[] = ['light', 'dark'];

export interface Token<V> {
  readonly name: string;
  readonly value: V;
  readonly usage: string;
  /** The core colour this token always equals, written as `{name}` in the design system so it follows edits. */
  readonly alias?: string;
}

export type ThemedValue = Readonly<Record<ThemeName, string>>;

/** Brand colours that never change with the theme. */
export const coreColors = [
  {
    name: 'volt',
    value: '#C8F54A',
    usage:
      "THE brand colour, Night Signal's one accent: a lit screen on a dark road. Main button, live state, the one key number, the logo symbol. Text on it is always `midnight` (15.3:1), never white. Never volt text on light grounds (1.15:1 on `paper`); use `brand-ink`. One volt thing per view.",
  },
  {
    name: 'midnight',
    value: '#0A0E17',
    usage:
      'Brand dark. Dark grounds, every on-bike screen ground, app bars, the wordmark on `paper` and on `volt`. `paper` text on it 17.6:1, `volt` 15.3:1.',
  },
  {
    name: 'paper',
    value: '#F4F5F0',
    usage:
      'Brand light. Light grounds, print, the wordmark on `midnight`. `ink` text on it 17.1:1.',
  },
  {
    name: 'graphite',
    value: '#161B26',
    usage:
      "Raised dark surface on `midnight`: cards on dark, the screen frame, the rider app's tiles. Text `paper` (15.7:1) or dark `ink-muted` (7.4:1); `volt` 13.6:1.",
  },
  {
    name: 'ion',
    value: '#6E7BFF',
    usage:
      'Data and maps on dark: second chart series, map routes, heat-map lows. 5.5:1 on `midnight`, 4.9:1 on `graphite`. Not for text on light grounds; use `data` there.',
  },
] as const satisfies readonly Token<string>[];

export type CoreColorName = (typeof coreColors)[number]['name'];

/** Interface colours that switch between Paper (light) and Midnight (dark). */
export const themedColors = [
  {
    name: 'surface-0',
    value: { light: '#F4F5F0', dark: '#0A0E17' },
    usage: 'Page ground. `ink` on it 17.1:1 light, 17.6:1 dark.',
  },
  {
    name: 'surface-1',
    value: { light: '#FBFBF8', dark: '#121723' },
    usage:
      'Cards, sheets, tiles. `ink`, `ink-muted` and `ink-subtle` all pass on it (subtle 5.9:1 light, 5.6:1 dark).',
  },
  {
    name: 'surface-2',
    value: { light: '#E7E9E2', dark: '#161B26' },
    usage:
      'Wells, table bands, input wells. `ink` 15.3:1 / 15.7:1, `ink-muted` 8.1:1 / 7.4:1, `ink-subtle` 5.0:1 / 5.4:1.',
  },
  {
    name: 'line',
    value: { light: '#DADDD4', dark: '#262D3B' },
    usage:
      'Hairlines and card borders, 1px. Decorative separation only; never the only cue for a control.',
  },
  {
    name: 'line-strong',
    value: { light: '#767C88', dark: '#606777' },
    usage:
      'Control borders that must be seen: inputs, secondary buttons, checkboxes. 3:1 or more on every surface in both themes (light 3.8 / 4.0 / 3.4:1, dark 3.4 / 3.2 / 3.0:1 on `surface-0` / `-1` / `-2`).',
  },
  {
    name: 'ink',
    value: { light: '#0E121B', dark: '#F4F5F0' },
    usage:
      'Main text and headings on every surface (17:1 on `surface-0` in both themes; 15:1+ on `surface-2`).',
  },
  {
    name: 'ink-muted',
    value: { light: '#3D4350', dark: '#A3AAB8' },
    usage:
      'Secondary text, descriptions, table body on all surfaces (9.1:1 light, 8.3:1 dark on `surface-0`; 7:1+ everywhere).',
  },
  {
    name: 'ink-subtle',
    value: { light: '#5B6272', dark: '#8A909C' },
    usage:
      'Captions, footnotes, timestamps on `surface-0` and `surface-1` (5.6:1+ light, 5.6:1+ dark). 5.0:1 / 5.4:1 on `surface-2`.',
  },
  {
    name: 'brand',
    value: { light: '#C8F54A', dark: '#C8F54A' },
    alias: 'volt',
    usage:
      'Brand fills in UI: the main button, live state, the one highlighted number tile. Text on it is `on-brand`. One per view.',
  },
  {
    name: 'on-brand',
    value: { light: '#0A0E17', dark: '#0A0E17' },
    usage: 'Text and icons on `brand` (15.3:1). Never white on volt.',
  },
  {
    name: 'brand-ink',
    value: { light: '#4F6B00', dark: '#C8F54A' },
    usage:
      'The accent as TEXT: eyebrows, links, the hero number on light grounds (5.6:1 on `surface-0` light, 5.0:1 on `surface-2`; 15.3:1 dark). Plain `volt` text on `paper` fails at 1.15:1; use this.',
  },
  {
    name: 'brand-soft',
    value: { light: '#EEFBC9', dark: '#26310D' },
    usage:
      'Quiet accent wash: selected chip, highlighted table row, callout ground. Text `ink` (17.2:1 light, 12.6:1 dark) or `brand-ink` (5.6:1 light).',
  },
  {
    name: 'data',
    value: { light: '#3B47D9', dark: '#6E7BFF' },
    usage: 'Second data series, links, map routes; as text 6.2:1 light, 5.5:1 dark on `surface-0`.',
  },
  {
    name: 'data-soft',
    value: { light: '#E6E8FF', dark: '#1B2150' },
    usage:
      'Data wash: map areas, selected series band. Text `ink` (15.5:1 / 13.9:1); `data` text on it 5.6:1 light but only 4.3:1 dark, so use `ink` on it in dark.',
  },
  {
    name: 'go',
    value: { light: '#137A4E', dark: '#3DDC97' },
    usage:
      'Status: done, paid, delivered, moving. Always with a word or icon. As text 4.9:1 on `surface-0` light (use on `surface-0`/`surface-1`, not `surface-2` at 4.4:1); 10.9:1 dark.',
  },
  {
    name: 'go-soft',
    value: { light: '#DDF5E9', dark: '#0F2E22' },
    usage: 'Ground for a `go` chip or row. `go` text on it 4.7:1 light, 8.3:1 dark.',
  },
  {
    name: 'stop',
    value: { light: '#C2341B', dark: '#FF6B4A' },
    usage:
      'Status: errors, shortfalls, failed checks. Always with a word or icon. As text 5.0:1 light, 6.9:1 dark on `surface-0`. UI only: never on on-bike screens (red reads as a brake light).',
  },
  {
    name: 'stop-soft',
    value: { light: '#FDE5DF', dark: '#3A1710' },
    usage: 'Ground for a `stop` chip or error row. `stop` text on it 4.6:1 light, 5.7:1 dark.',
  },
  {
    name: 'focus',
    value: { light: '#0E121B', dark: '#C8F54A' },
    usage:
      'Focus ring: 2px solid, 2px offset, on every interactive element. Ink on light, volt on dark (13:1+ on every surface).',
  },
] as const satisfies readonly Token<ThemedValue>[];

export type ThemedColorName = (typeof themedColors)[number]['name'];

/** One theme's colours by name, e.g. `themes.dark['surface-0']`. */
export const themes = Object.fromEntries(
  themeNames.map((theme) => [
    theme,
    Object.fromEntries(themedColors.map((token) => [token.name, token.value[theme]])),
  ]),
) as Readonly<Record<ThemeName, Readonly<Record<ThemedColorName, string>>>>;

/** Font stacks by role. Anek for words (Latin, Telugu, Devanagari), IBM Plex Mono for figures. */
export const fontFamilies = {
  display: '"Anek Latin", Arial, sans-serif',
  body: '"Anek Latin", "Anek Telugu", "Anek Devanagari", Arial, sans-serif',
  mono: '"IBM Plex Mono", "Courier New", monospace',
  telugu: '"Anek Telugu", "Anek Latin", sans-serif',
  devanagari: '"Anek Devanagari", "Anek Latin", sans-serif',
} as const;

export type FontFamilyName = keyof typeof fontFamilies;

/** Loads every face the stacks name (variable width 75–125 and weight 100–800 for Anek). */
export const googleFontsUrl =
  'https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,100..800&family=Anek+Telugu:wdth,wght@75..125,100..800&family=Anek+Devanagari:wdth,wght@75..125,100..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

export interface TextStyle {
  readonly name: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly fontWeight: number;
  readonly letterSpacing?: string;
  /** Anek width axis in % (`font-stretch`): 110 for display styles, 100 for text. */
  readonly width?: number;
  readonly sample: string;
  readonly usage: string;
}

export interface TextStyleGroup {
  readonly name: string;
  readonly family: FontFamilyName;
  readonly styles: readonly TextStyle[];
}

export const textStyles: readonly TextStyleGroup[] = [
  {
    name: 'Display',
    family: 'display',
    styles: [
      {
        name: 'display-xl',
        fontSize: '96px',
        lineHeight: '0.95',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        width: 110,
        sample: 'Be seen where the city moves.',
        usage:
          'One line per piece: covers, hoardings, screen headlines. Anek Latin 800 at wdth 110 (`font-stretch: 110%`).',
      },
      {
        name: 'display-l',
        fontSize: '64px',
        lineHeight: '1',
        fontWeight: 800,
        letterSpacing: '-0.015em',
        width: 110,
        sample: '200 plays. One brand.',
        usage: 'Section openers, slide titles, poster headlines. Anek Latin 800, wdth 110.',
      },
      {
        name: 'headline',
        fontSize: '40px',
        lineHeight: '1.1',
        fontWeight: 700,
        letterSpacing: '-0.01em',
        width: 110,
        sample: 'Book the city by the hour',
        usage: 'Page and card headlines. Anek Latin 700, wdth 110.',
      },
      {
        name: 'numeral',
        fontSize: '56px',
        lineHeight: '1',
        fontWeight: 800,
        letterSpacing: '-0.02em',
        width: 110,
        sample: '₹36,750',
        usage: 'Hero numbers on tiles and slides. Anek Latin 800, wdth 110, tabular figures.',
      },
    ],
  },
  {
    name: 'Text',
    family: 'body',
    styles: [
      {
        name: 'title',
        fontSize: '24px',
        lineHeight: '32px',
        fontWeight: 600,
        width: 100,
        sample: '₹25 an hour + 25% of the sale',
        usage: 'Card titles, dialog titles, table titles. Anek Latin 600, wdth 100.',
      },
      {
        name: 'body-l',
        fontSize: '18px',
        lineHeight: '28px',
        fontWeight: 400,
        width: 100,
        sample: 'Brands buy bike-hours. Riders are paid for moving hours.',
        usage: 'Lead paragraphs, brand book text, marketing pages. Anek Latin 400, wdth 100.',
      },
      {
        name: 'body',
        fontSize: '16px',
        lineHeight: '24px',
        fontWeight: 400,
        width: 100,
        sample: 'The clock pauses after 5 minutes stopped.',
        usage:
          'Default UI and document text. Anek Latin 400/500, wdth 100. Measure 60–72 characters.',
      },
      {
        name: 'label',
        fontSize: '12px',
        lineHeight: '16px',
        fontWeight: 600,
        letterSpacing: '0.12em',
        width: 100,
        sample: 'PLAYS DELIVERED',
        usage: 'Eyebrows, column headers, chip text. Uppercase, tracked. Anek Latin 600, wdth 100.',
      },
      {
        name: 'caption',
        fontSize: '13px',
        lineHeight: '18px',
        fontWeight: 400,
        width: 100,
        sample: 'Before GST. People counts are approximate.',
        usage: 'Footnotes, sources, helper text. `ink-subtle`.',
      },
    ],
  },
  {
    name: 'Data',
    family: 'mono',
    styles: [
      {
        name: 'data',
        fontSize: '14px',
        lineHeight: '20px',
        fontWeight: 500,
        sample: 'BH 3,00,000 · ₹250.00/h',
        usage:
          'Tables of figures, IDs, bills, timestamps, GPS logs. IBM Plex Mono 500. Indian digit grouping.',
      },
    ],
  },
  {
    name: 'Telugu',
    family: 'telugu',
    styles: [
      {
        name: 'telugu-headline',
        fontSize: '40px',
        lineHeight: '1.35',
        fontWeight: 700,
        width: 110,
        sample: 'మీ ప్రయాణం, మీ అదనపు ఆదాయం',
        usage:
          'Telugu headlines for rider and local-brand creatives. Anek Telugu 700, wdth 110. Needs the extra line height for vowel signs.',
      },
      {
        name: 'telugu-body',
        fontSize: '18px',
        lineHeight: '30px',
        fontWeight: 400,
        width: 100,
        sample: 'గంటకు ₹25 + 25%',
        usage: 'Telugu body copy in the rider app and posters. Anek Telugu 400, wdth 100.',
      },
    ],
  },
];

/** 8-point grid with a 4px half step. Layouts use 8, 16, 24, 32, 48, 64, 96. */
export const spacing = [
  { name: 'space-1', value: 4, usage: 'Icon-to-label gap, chip inner gap.' },
  { name: 'space-2', value: 8, usage: 'Tight stacks: label over value.' },
  {
    name: 'space-3',
    value: 16,
    usage: 'Default gap; button horizontal padding; phone side gutter.',
  },
  { name: 'space-4', value: 24, usage: 'Card padding; gap between cards.' },
  { name: 'space-5', value: 32, usage: 'Section inner padding on phones.' },
  { name: 'space-6', value: 48, usage: 'Gap between page sections.' },
  { name: 'space-7', value: 64, usage: 'Desktop section padding; poster margins.' },
  { name: 'space-8', value: 96, usage: 'Hero padding, slide margins (scaled).' },
] as const satisfies readonly Token<number>[];

/** Night Signal corners in px: 6 on controls, 14 on cards, 20 on hero panels and screen frames, pills for status only. */
export const radii = [
  { name: 'radius-xs', value: 4, usage: 'Tags, small inputs, the geofenced field highlight.' },
  { name: 'radius-sm', value: 6, usage: 'Controls: buttons, inputs, selectable table cells.' },
  { name: 'radius-md', value: 14, usage: 'Cards, sheets, tiles, image frames.' },
  { name: 'radius-screen', value: 20, usage: 'Screen frames and hero panels.' },
  { name: 'radius-pill', value: 999, usage: 'Status chips, filter chips and toggles only.' },
] as const satisfies readonly Token<number>[];

/** Flat by default. Separation comes from surface steps and hairlines; one lift shadow for floating layers only. */
export const shadows = [
  {
    name: 'shadow-lift',
    value: { light: '0 8px 24px rgba(14,16,19,0.12)', dark: '0 8px 24px rgba(0,0,0,0.45)' },
    usage: 'Menus, popovers, the floating booking bar. Never on cards in a grid.',
  },
] as const satisfies readonly Token<ThemedValue>[];

/** Line width in px. Night Signal uses 1 px lines. */
export const lineWidth = 1;

/** Looks a spacing or radius token up by name, in px. */
export function px(
  token: (typeof spacing)[number]['name'] | (typeof radii)[number]['name'],
): number {
  const found = [...spacing, ...radii].find((entry) => entry.name === token);
  if (!found) throw new RangeError(`Unknown token ${token}`);
  return found.value;
}
