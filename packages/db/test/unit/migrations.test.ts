import { describe, expect, it } from 'vitest';
import { readMigrations } from '../../src/migrate.js';

describe('migration files', () => {
  const all = readMigrations();

  it('are numbered in order with no gaps or repeats', () => {
    expect(all.map((m) => m.name.slice(0, 4))).toEqual(
      all.map((_, i) => String(i + 1).padStart(4, '0')),
    );
  });

  it('each says what it is for in its first line', () => {
    for (const m of all) expect(m.sql.startsWith('-- ')).toBe(true);
  });

  it('never delete data: no DROP TABLE, TRUNCATE or DELETE FROM', () => {
    for (const m of all)
      expect(m.sql).not.toMatch(/\b(DROP\s+TABLE|TRUNCATE\s+\w|DELETE\s+FROM)\b/i);
  });

  // P7.4: a release can always be rolled back to the one before it, whose code still runs on the
  // newer database: a migration only adds. Never a column dropped, renamed or retyped, never a
  // column made required, and a new required column always has a default (old code leaves it out).
  it('only add, so the release before still runs on the newer database', () => {
    for (const m of all) {
      expect(m.sql, m.name).not.toMatch(
        /\b(DROP\s+COLUMN|RENAME\s+(COLUMN|TO)|ALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE|SET\s+NOT\s+NULL)\b/i,
      );
      for (const [line] of m.sql.matchAll(/ADD\s+COLUMN[^;,\n]*/gi))
        if (/NOT\s+NULL/i.test(line)) expect(line, m.name).toMatch(/DEFAULT/i);
    }
  });

  it('every table is protected from edits or deletes', () => {
    for (const m of all) {
      for (const [, table] of m.sql.matchAll(/CREATE TABLE (\w+)/g)) {
        expect(m.sql, table).toMatch(
          new RegExp(`BEFORE (UPDATE OR )?DELETE ON ${table}\\b|BEFORE UPDATE ON ${table}\\b`),
        );
      }
    }
  });
});
