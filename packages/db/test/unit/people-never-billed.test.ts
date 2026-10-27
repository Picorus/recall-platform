// Hard rule 7: people counts are estimates and are never billed. Only the files that carry, total or
// show the counts may read them; everything else (bookings, ledger, make-ups, refunds, cuts, rider
// pay, payouts, GST, supply, every service and app) must never see them. Every source file in the
// repository is scanned, so a new file that reads a count fails here on purpose.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../../..');
/** Carry the signed count, total it per line, and show it as a range. */
const ALLOWED = [
  'packages/domain/src/plays.ts',
  'packages/domain/src/screen-reports.ts',
  'packages/domain/src/moving-hours.ts',
  'packages/domain/src/people.ts',
  'packages/domain/src/price-book.ts',
  'packages/domain/src/index.ts',
  'packages/domain/src/report.ts',
  'packages/db/src/plays.ts',
  'packages/db/src/screen-reports.ts',
  'packages/db/src/people.ts',
  'packages/db/src/index.ts',
  'packages/db/src/reports.ts',
  'services/workers/src/report-html.ts',
  'services/workers/src/report-pdf.ts',
  // the box's signed play record carries the count (P2.7), and the shared cases for it
  'apps/player/core/src/main/kotlin/app/recall/player/core/PlayLog.kt',
  // the box's minute summary carries the count the same way (P2.8.1)
  'apps/player/core/src/main/kotlin/app/recall/player/core/Minutes.kt',
  'packages/domain/scripts/play-vectors.ts',
  // design system sample text ("People counts are approximate."), no numbers
  'packages/design/src/tokens.ts',
  // the rider app's words: the camera line in the agreement ("This screen counts people. It records
  // nothing."), in three languages; no numbers (P4.2)
  'apps/rider/src/i18n.ts',
  // the brand portal's words: the report rule a brand agrees to ("an estimate of people who saw it
  // (approximate, never billed)") and an ad tip ("people see it for a few seconds"); no numbers (P5.5-6)
  'packages/domain/src/booking-terms.ts',
  'apps/brand/app/ads/page.tsx',
];
/** Lines allowed elsewhere: loading the people settings with the price book. */
const ALLOWED_LINES = [
  'people: { ...DEFAULT_PEOPLE_RULES, ...book.people },',
  'DEFAULT_PEOPLE_RULES,',
];
const SKIP = new Set(['node_modules', 'dist', 'build', '.turbo', '.next', 'test', 'tests', 'docs']);

/** Code without comments. */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => !ALLOWED_LINES.includes(l))
    .join('\n');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f.startsWith('.') || SKIP.has(f)) return [];
    const path = join(dir, f);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|kt)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f) ? [path] : [];
  });
}

describe('people counts are never billed (hard rule 7)', () => {
  it('only the counting and reporting files read people counts, anywhere in the code', () => {
    const files = ['packages', 'services', 'apps', 'tools'].flatMap((d) => sources(join(ROOT, d)));
    expect(files.length).toBeGreaterThan(50);
    const readers = files
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.includes(f))
      .filter((f) => /people/i.test(code(readFileSync(join(ROOT, f), 'utf8'))));
    expect(readers).toEqual([]);
  });
});
