// Applies new migrations to the database in DATABASE_URL:  pnpm --filter @recall/db migrate
import pg from 'pg';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL (see .env.example).');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url });
try {
  const applied = await migrate(pool);
  console.log(applied.length === 0 ? 'Database is up to date.' : `Applied: ${applied.join(', ')}`);
} finally {
  await pool.end();
}
