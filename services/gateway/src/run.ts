// Starts the gateway from the environment (names in .env.example; values never in the repository).
import { fakeFileStore } from '@recall/adapters';
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
// P2.4.2: the screens' download links, signed as the API's file store signs them (the real store
// comes in P6). Without the shared key, or without an HTTPS address, no file lists are sent.
// Production has no ad files until the real store (as the API, config.ts filesFrom).
const linkSecret = process.env.FILES_LINK_SECRET;
const filesUrl = process.env.FILES_PUBLIC_URL;
if (linkSecret && linkSecret.length < MIN_SECRET)
  throw new Error(`FILES_LINK_SECRET must be at least ${MIN_SECRET} characters`);
const links =
  linkSecret && filesUrl && process.env.NODE_ENV !== 'production'
    ? fakeFileStore({ baseUrl: filesUrl, secret: linkSecret })
    : undefined;
if (!links)
  console.error(
    'gateway: WARNING: FILES_LINK_SECRET or FILES_PUBLIC_URL is not set: screens get no ad file lists',
  );
else void checkLinks(links.readLink('0'.repeat(64), Math.floor(Date.now() / 1000) + 300));

/**
 * Review m3: whether the API takes the gateway's links. A made-up file signed right is "not found"
 * (404); signed with another key, "not valid" (403): then the two keys differ.
 */
async function checkLinks(url: string): Promise<void> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (r.status === 403)
      console.error(
        "gateway: WARNING: the API refuses the gateway's download links: FILES_LINK_SECRET differs between them",
      );
  } catch (e) {
    console.error(
      `gateway: could not check the download links with the API: ${(e as Error).message}`,
    );
  }
}
const gw = await startGateway(pool, {
  ...(links ? { links } : {}),
  mqttUrl: need('GATEWAY_MQTT_URL'),
  hookHost: process.env.GATEWAY_HOOK_HOST || '127.0.0.1',
  hookPort: Number(process.env.GATEWAY_HOOK_PORT || 8090),
  token: secret('GATEWAY_HOOK_TOKEN'),
  gatewayUser: 'recall-gateway',
  gatewayPassword: secret('GATEWAY_MQTT_PASSWORD'),
});
await gw.connect();
console.log(`gateway: hooks on port ${gw.hookPort}, connected to the broker`);
