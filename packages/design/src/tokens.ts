// Night Signal design tokens (docs/NIGHT_SIGNAL.md, decided 22 Oct 2026). One source for every app.
// Change colours there first, then here; the tests hold the contrast promises made in that file.

/** Brand colours that never change with the theme. */
export const core = {
  volt: '#C8F54A',
  midnight: '#0A0E17',
  paper: '#F4F5F0',
  graphite: '#161B26',
  ion: '#6E7BFF',
} as const;

export type ThemeName = 'light' | 'dark';

export interface Theme {
  /** Page ground */
  readonly surface0: string;
  /** Cards */
  readonly surface1: string;
  /** Wells, table bands */
  readonly surface2: string;
  /** Hairlines */
  readonly line: string;
  /** Control borders */
  readonly lineStrong: string;
  /** Main text */
  readonly ink: string;
  /** Secondary text */
  readonly inkMuted: string;
  /** Captions */
  readonly inkSubtle: string;
  /** Brand fills (the one volt element per view) */
  readonly brand: string;
  /** Text on brand */
  readonly onBrand: string;
  /** Accent as text */
  readonly brandInk: string;
  /** Accent wash */
  readonly brandSoft: string;
  /** Second series, links, maps */
  readonly data: string;
  readonly dataSoft: string;
  /** Done, paid, delivered */
  readonly go: string;
  readonly goSoft: string;
  /** Errors, shortfalls */
  readonly stop: string;
  readonly stopSoft: string;
  /** Focus ring */
  readonly focus: string;
}

export const themes: Readonly<Record<ThemeName, Theme>> = {
  light: {
    surface0: '#F4F5F0',
    surface1: '#FBFBF8',
    surface2: '#E7E9E2',
    line: '#DADDD4',
    lineStrong: '#767C88',
    ink: '#0E121B',
    inkMuted: '#3D4350',
    inkSubtle: '#5B6272',
    brand: '#C8F54A',
    onBrand: '#0A0E17',
    brandInk: '#4F6B00',
    brandSoft: '#EEFBC9',
    data: '#3B47D9',
    dataSoft: '#E6E8FF',
    go: '#137A4E',
    goSoft: '#DDF5E9',
    stop: '#C2341B',
    stopSoft: '#FDE5DF',
    focus: '#0E121B',
  },
  dark: {
    surface0: '#0A0E17',
    surface1: '#121723',
    surface2: '#161B26',
    line: '#262D3B',
    lineStrong: '#5B6272',
    ink: '#F4F5F0',
    inkMuted: '#A3AAB8',
    inkSubtle: '#8A909C',
    brand: '#C8F54A',
    onBrand: '#0A0E17',
    brandInk: '#C8F54A',
    brandSoft: '#26310D',
    data: '#6E7BFF',
    dataSoft: '#1B2150',
    go: '#3DDC97',
    goSoft: '#0F2E22',
    stop: '#FF6B4A',
    stopSoft: '#3A1710',
    focus: '#C8F54A',
  },
};

export const fonts = {
  /** Headings and text. Variable: width 75–125, weight 100–800. */
  sans: "'Anek Latin', system-ui, sans-serif",
  telugu: "'Anek Telugu', 'Anek Latin', system-ui, sans-serif",
  devanagari: "'Anek Devanagari', 'Anek Latin', system-ui, sans-serif",
  /** Numbers in tables, IDs, bills. */
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

export const googleFontsUrl =
  'https://fonts.googleapis.com/css2?family=Anek+Latin:wdth,wght@75..125,100..800&family=Anek+Telugu:wdth,wght@75..125,100..800&family=Anek+Devanagari:wdth,wght@75..125,100..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

/** Weight and width per role (NIGHT_SIGNAL.md: headlines 700–800 at wdth 110; text 400–600 at wdth 100). */
export const fontStyles = {
  headline: { weight: 700, width: 110 },
  headlineHeavy: { weight: 800, width: 110 },
  text: { weight: 400, width: 100 },
  textMedium: { weight: 500, width: 100 },
  textStrong: { weight: 600, width: 100 },
  number: { weight: 500, width: 100 },
} as const;

/** Text sizes in px, with line heights. A starting scale (DECISIONS 22 Oct 2026); tune in P0.3.2. */
export const textSizes = {
  caption: { size: 12, lineHeight: 16 },
  small: { size: 14, lineHeight: 20 },
  body: { size: 16, lineHeight: 24 },
  lead: { size: 18, lineHeight: 28 },
  title: { size: 22, lineHeight: 28 },
  heading: { size: 28, lineHeight: 34 },
  display: { size: 40, lineHeight: 44 },
  hero: { size: 56, lineHeight: 60 },
} as const;

/** Spacing in px on a 4 px grid. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

/** Corner radius in px: controls, cards, hero panels and screen frames, pills. */
export const radius = {
  control: 6,
  card: 14,
  hero: 20,
  pill: 999,
} as const;

/** Line width in px. Night Signal uses 1 px lines only. */
export const lineWidth = 1;
