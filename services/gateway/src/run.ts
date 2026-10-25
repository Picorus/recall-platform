// Starts the gateway from the environment (names in .env.example; values never in the repository).
import pg from 'pg';
import { startGateway } from './gateway.js';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const pool = new pg.Pool({ connectionString: need('DATABASE_URL') });
const gw = await startGateway(pool, {
  mqttUrl: need('GATEWAY_MQTT_URL'),
  hookHost: process.env.GATEWAY_HOOK_HOST || '127.0.0.1',
  hookPort: Number(process.env.GATEWAY_HOOK_PORT || 8090),
  token: need('GATEWAY_HOOK_TOKEN'),
  gatewayUser: 'recall-gateway',
  gatewayPassword: need('GATEWAY_MQTT_PASSWORD'),
});
await gw.connect();
console.log(`gateway: hooks on port ${gw.hookPort}, connected to the broker`);
