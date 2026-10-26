// Starts the API from the environment.
import { createServer } from 'node:http';
import pg from 'pg';
import { readConfig } from './config.js';
import { apiHandler } from './staff-api.js';

// A mistake in one request must never stop the API for everyone.
process.on('unhandledRejection', (e) => console.error('api: unhandled', e));

const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
const server = createServer(apiHandler(pool, cfg));
server.listen(cfg.port, cfg.host, () => console.log(`api: listening on ${cfg.host}:${cfg.port}`));
