// Starts the API from the environment.
import { createServer } from 'node:http';
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
