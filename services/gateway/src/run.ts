// Starts the gateway from the environment (names in .env.example; values never in the repository).
import pg from 'pg';
import { MIN_SECRET } from './emqx-config.js';
import { AT_ONCE, startGateway } from './gateway.js';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const secret = (name: string) => {
  const v = need(name);
  if (v.length < MIN_SECRET) throw new Error(`${name} must be at least ${MIN_SECRET} characters`);
  return v;
};

// P7.2: one connection for each message handled at once, plus a few for hooks and commands (the
// default of 10 held the gateway to 10 messages at a time, whatever AT_ONCE said).
const pool = new pg.Pool({ connectionString: need('DATABASE_URL'), max: AT_ONCE + 4 });
// A connection the database drops while idle (a restart, a failover) is logged and replaced, never
// allowed to stop the gateway.
pool.on('error', (e) => console.error(`gateway: database connection lost: ${e.message}`));
const gw = await startGateway(pool, {
  mqttUrl: need('GATEWAY_MQTT_URL'),
  hookHost: process.env.GATEWAY_HOOK_HOST || '127.0.0.1',
  hookPort: Number(process.env.GATEWAY_HOOK_PORT || 8090),
  token: secret('GATEWAY_HOOK_TOKEN'),
  gatewayUser: 'recall-gateway',
  gatewayPassword: secret('GATEWAY_MQTT_PASSWORD'),
});
await gw.connect();
console.log(`gateway: hooks on port ${gw.hookPort}, connected to the broker`);
