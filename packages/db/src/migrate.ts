// Runs the plain-SQL migrations in `migrations/` in name order, each once, each in its own
// transaction. A migration that was already run and then edited is refused: fix forward with a new
// file instead (hard rule 3: nothing is changed in place).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

export function readMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const name of names) {
    if (!NAME.test(name)) throw new Error(`Migration name must look like 0001_what.sql: ${name}`);
  }
  return names.map((name) => {
    const sql = readFileSync(new URL(name, dir), 'utf8');
    // The runner wraps each file in one transaction; a file that ends it itself could half-apply.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im.test(sql)) {
      throw new Error(`Migration ${name} must not contain BEGIN, COMMIT or ROLLBACK`);
    }
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  });
}

/** Applies what is new. Returns the names it applied. Safe to run twice, or from two places at once. */
export async function migrate(pool: Pool, migrations = readMigrations()): Promise<string[]> {
  const client = await pool.connect();
  try {
    // One runner at a time across every app that starts up.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['recall-migrations']);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Map(
      (
        await client.query<{ name: string; sha256: string }>(
          'SELECT name, sha256 FROM schema_migrations',
        )
      ).rows.map((r) => [r.name, r.sha256]),
    );
    const applied: string[] = [];
    for (const m of migrations) {
      const seen = done.get(m.name);
      if (seen !== undefined) {
        if (seen !== m.sha256) {
          throw new Error(
            `Migration ${m.name} was changed after it ran. Add a new migration instead.`,
          );
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [
          m.name,
          m.sha256,
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(m.name);
    }
    return applied;
  } finally {
    // If the lock cannot be released, throw the connection away rather than pool it still locked.
    const unlockError = await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', ['recall-migrations'])
      .then(
        () => undefined,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );
    client.release(unlockError);
  }
}
