// P7.5: is the system ready for the POC? Reads the database in DATABASE_URL and the outside services
// this API would start with (the same environment), and prints each item, yes or no, with what to
// do. Exits 1 while anything is not ready. Changes nothing.
//   pnpm --filter @recall/api readiness
import { pocReadiness } from '@recall/db';
import pg from 'pg';
import { readConfig } from './config.js';

const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 2 });
try {
  const items = await pocReadiness(pool, cfg.connections ?? [], Math.floor(Date.now() / 1000));
  for (const i of items)
    console.log(
      `${i.ok ? 'READY  ' : 'NOT YET'}  ${i.item}: ${i.now}${i.ok ? '' : `\n          → ${i.todo}`}`,
    );
  const left = items.filter((i) => !i.ok).length;
  console.log(left === 0 ? '\nReady for the POC.' : `\n${left} of ${items.length} not ready yet.`);
  process.exitCode = left === 0 ? 0 : 1;
} finally {
  await pool.end();
}
