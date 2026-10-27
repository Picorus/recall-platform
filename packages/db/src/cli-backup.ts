// P7.4 backups from the command line (see backup.ts):
//   pnpm --filter @recall/db backup -- --out recall.dump
//   pnpm --filter @recall/db backup -- --restore recall.dump --into recall_restored
//   pnpm --filter @recall/db backup -- --drill [--dir /tmp]
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { backupDatabase, checkRestore, restoreDatabase, restoreDrill } from './backup.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (see .env.example).');
  process.exit(1);
}
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    out: { type: 'string' },
    restore: { type: 'string' },
    into: { type: 'string' },
    drill: { type: 'boolean' },
    dir: { type: 'string' },
  },
});

try {
  if (values.out) {
    const hash = await backupDatabase(url, values.out);
    console.log(`Backed up to ${values.out} (sha256 ${hash}, also in ${values.out}.sha256).`);
  } else if (values.restore && values.into) {
    const restored = await restoreDatabase(values.restore, url, values.into);
    const check = await checkRestore(url, restored);
    console.log(`Restored into ${values.into}: ${check.tables} tables.`);
    if (check.differences.length > 0)
      console.log(
        `Differs from ${new URL(url).pathname.slice(1)} (expected if it changed since the backup):\n  ${check.differences.join('\n  ')}`,
      );
  } else if (values.drill) {
    const r = await restoreDrill(url, values.dir ?? tmpdir());
    if (r.differences.length > 0) {
      console.error(`DRILL FAILED: the restore differs:\n  ${r.differences.join('\n  ')}`);
      process.exitCode = 1;
    } else
      console.log(`Drill passed: backed up, restored and compared ${r.tables} tables (${r.file}).`);
  } else {
    console.error('Say --out <file>, --restore <file> --into <name>, or --drill.');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
