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
