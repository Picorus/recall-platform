// Starts the API from the environment.
import { createServer } from 'node:http';
import { expireUnpaid } from '@recall/db';
import pg from 'pg';
import { readConfig } from './config.js';
import { apiHandler } from './staff-api.js';

// A mistake in one request must never stop the API for everyone.
process.on('unhandledRejection', (e) => console.error('api: unhandled', e));

const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
// A connection the database drops while idle (a restart, a failover) is logged and replaced, never
// allowed to stop the API.
pool.on('error', (e) => console.error(`api: database connection lost: ${e.message}`));
const server = createServer(apiHandler(pool, cfg));
server.listen(cfg.port, cfg.host, () => console.log(`api: listening on ${cfg.host}:${cfg.port}`));

// Every minute: bookings whose payment link ran out unpaid are cancelled, so their bikes go back on
// sale (P3.8.2). Each run finishes before the next starts; a failure is logged and tried next time.
const payments = cfg.payments;
if (payments) {
  const tick = () => {
    expireUnpaid(pool, payments, Math.floor(Date.now() / 1000))
      .then((ids) => {
        if (ids.length > 0) console.log(`api: unpaid bookings cancelled: ${ids.join(', ')}`);
      })
      .catch((e: unknown) => console.error('api: expiring payment links failed', e))
      .finally(() => setTimeout(tick, 60_000).unref());
  };
  setTimeout(tick, 60_000).unref();
}
