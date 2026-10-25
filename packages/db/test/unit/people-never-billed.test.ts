// Hard rule 7: people counts are estimates and are never billed. Only the files that carry or show
// the counts may read them; money code (bookings, ledger, make-ups, refunds, cuts, rider pay,
// payouts, GST, supply) must never see them. A new file that reads a count fails here on purpose.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../..');
const ALLOWED: Record<string, readonly string[]> = {
  // carry the signed count, total it per line, and show it as a range
  'domain/src': [
    'plays.ts',
    'screen-reports.ts',
    'moving-hours.ts',
    'people.ts',
    'price-book.ts',
    'index.ts',
  ],
  'db/src': ['plays.ts', 'screen-reports.ts', 'people.ts', 'index.ts'],
};
/** Lines allowed elsewhere: loading the people settings with the price book. */
const ALLOWED_LINES = [
  'people: { ...DEFAULT_PEOPLE_RULES, ...x.book.people },',
  'DEFAULT_PEOPLE_RULES,',
];

/** Code without comments. */
const code = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter((l) => !ALLOWED_LINES.includes(l))
    .join('\n');

describe('people counts are never billed (hard rule 7)', () => {
  for (const [dir, allowed] of Object.entries(ALLOWED)) {
    it(`only the counting and reporting files in ${dir} read people counts`, () => {
      const readers = readdirSync(join(ROOT, dir))
        .filter((f) => f.endsWith('.ts') && !allowed.includes(f))
        .filter((f) => /people/i.test(code(readFileSync(join(ROOT, dir, f), 'utf8'))));
      expect(readers).toEqual([]);
    });
  }
});
