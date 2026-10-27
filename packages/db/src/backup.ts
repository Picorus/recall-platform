// P7.4: a backup of the whole database, a restore into a new one, and a check that the restore holds
// exactly what the source held. A backup is one file (pg_dump's own format) with its SHA-256 beside
// it; a restore checks that first, never writes into a database that already exists, and follows
// TimescaleDB's steps for the time-split tables (plays, minute summaries, screen health). The check
// compares every table's rows, the ledger's totals per account and the migrations applied.
//   pnpm --filter @recall/db backup -- --out recall.dump
//   pnpm --filter @recall/db backup -- --restore recall.dump --into recall_restored
//   pnpm --filter @recall/db backup -- --drill        (back up, restore, compare, drop: proves it works)
// Needs pg_dump and pg_restore of the server's major version (16) on the machine that runs it.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);
/** pg_dump on a large database writes a lot to stderr; keep enough to show what went wrong. */
const MAX_OUTPUT = 64 * 1024 * 1024;

const sha256Of = (file: string) =>
  new Promise<string>((ok, no) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => ok(h.digest('hex')))
      .on('error', no);
  });

/** Backs the database at `url` up into `file`, with `file`.sha256 beside it. Returns the hash. */
export async function backupDatabase(url: string, file: string): Promise<string> {
  await run('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, `--dbname=${url}`], {
    maxBuffer: MAX_OUTPUT,
  });
  const hash = await sha256Of(file);
  await writeFile(`${file}.sha256`, `${hash}\n`);
  return hash;
}

/** The same server as `url`, with database `name`. */
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

/**
 * Restores `file` into a new database `name` on the server at `serverUrl` (any database on it).
 * Refused when the file does not match its .sha256, or when `name` exists already: a restore
 * never writes over a database. Returns the new database's address.
 */
export async function restoreDatabase(
  file: string,
  serverUrl: string,
  name: string,
): Promise<string> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
    throw new Error('the new database name: small letters, digits and _ only');
  const expected = (await readFile(`${file}.sha256`, 'utf8')).trim();
  if ((await sha256Of(file)) !== expected)
    throw new Error(`${file} does not match its .sha256: damaged or changed, not restored`);
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if ((exists.rowCount ?? 0) > 0)
      throw new Error(`database ${name} exists already: a restore never writes over one`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const target = withDatabase(serverUrl, name);
  // TimescaleDB's way: its extension first, then the restore in its restoring mode.
  const c = new pg.Client({ connectionString: target });
  await c.connect();
  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await c.query('SELECT timescaledb_pre_restore()');
    await run('pg_restore', ['--no-owner', '--exit-on-error', `--dbname=${target}`, file], {
      maxBuffer: MAX_OUTPUT,
    });
    await c.query('SELECT timescaledb_post_restore()');
  } finally {
    await c.end();
  }
  return target;
}

export interface RestoreCheck {
  /** Each table's rows, in the source and in the restore. */
  readonly tables: number;
  /** What differs (empty: the restore holds exactly what the source held). */
  readonly differences: readonly string[];
}

/** What a database holds, to compare two: rows per table, ledger totals per account, migrations. */
async function snapshot(url: string): Promise<Map<string, string>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const out = new Map<string, string>();
    const tables = await c.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    for (const { name } of tables.rows) {
      const n = await c.query<{ n: string }>(`SELECT count(*) AS n FROM "${name}"`);
      out.set(`rows in ${name}`, n.rows[0]?.n ?? '0');
    }
    const ledger = await c.query<{ account: string; d: string; c: string }>(
      `SELECT account, sum(debit) AS d, sum(credit) AS c FROM ledger_postings
        GROUP BY account ORDER BY account`,
    );
    for (const r of ledger.rows) out.set(`ledger ${r.account}`, `${r.d} debit, ${r.c} credit`);
    const migrations = await c.query<{ name: string; sha256: string }>(
      'SELECT name, sha256 FROM schema_migrations ORDER BY name',
    );
    out.set('migrations', migrations.rows.map((m) => `${m.name}:${m.sha256}`).join(','));
    return out;
  } finally {
    await c.end();
  }
}

/** Compares a restore with its source: every table's rows, ledger totals, migrations. */
export async function checkRestore(sourceUrl: string, restoredUrl: string): Promise<RestoreCheck> {
  const [a, b] = await Promise.all([snapshot(sourceUrl), snapshot(restoredUrl)]);
  const differences: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()]))
    if (a.get(key) !== b.get(key))
      differences.push(
        `${key}: ${a.get(key) ?? 'missing'} in the source, ${b.get(key) ?? 'missing'} restored`,
      );
  return {
    tables: [...a.keys()].filter((k) => k.startsWith('rows in ')).length,
    differences,
  };
}

/**
 * The restore drill: backs `url` up, restores it into a new database on the same server, compares
 * the two, and drops the copy. Run it on a schedule: a backup is only good once it was restored.
 */
export async function restoreDrill(
  url: string,
  dir: string,
): Promise<RestoreCheck & { file: string; hash: string }> {
  const name = `recall_drill_${randomBytes(4).toString('hex')}`;
  const file = `${dir}/${name}.dump`;
  const hash = await backupDatabase(url, file);
  const restored = await restoreDatabase(file, url, name);
  try {
    return { ...(await checkRestore(url, restored)), file, hash };
  } finally {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).finally(() => admin.end());
  }
}
