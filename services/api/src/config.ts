// The API's settings from the environment (names in .env.example; values never in the repository).
import {
  fakeBankCheck,
  fakeEsign,
  fakeFileStore,
  fakeKyc,
  fakePayments,
  type FileStore,
  type PaymentsAdapter,
} from '@recall/adapters';
import { randomBytes } from 'node:crypto';
import { readKey } from './secrets.js';
import type { StaffApiConfig } from './staff-api.js';

export interface ApiConfig extends StaffApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
}

/** A fixed key for a laptop only: the API refuses it anywhere NODE_ENV is production. */
const LAPTOP_KEY = '00'.repeat(32);

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.NODE_ENV === 'production';
  const need = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const keyText = env.STAFF_SECRET_KEY || (production ? need('STAFF_SECRET_KEY') : LAPTOP_KEY);
  if (production && keyText === LAPTOP_KEY) throw new Error('STAFF_SECRET_KEY is the laptop key');
  const origins = (
    env.ADMIN_ORIGINS || (production ? need('ADMIN_ORIGINS') : 'http://localhost:3001')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const secureCookies = env.API_INSECURE_COOKIES !== 'yes';
  if (production && !secureCookies) throw new Error('API_INSECURE_COOKIES is for a laptop only');
  // How many of our own proxies stand in front (0 on a laptop). It must be said in production: a
  // wrong count makes every caller look the same (or lets callers choose their own address).
  const hopsText = env.API_PROXY_HOPS || (production ? need('API_PROXY_HOPS') : '0');
  const proxyHops = Number(hopsText);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 5)
    throw new Error('API_PROXY_HOPS must be a whole number 0 to 5');
  // In production a load balancer must stand in front of the admin site: without one, either every
  // caller looks the same (0) or callers can write their own address (the admin site passes the
  // header on unchanged).
  if (production && proxyHops < 1)
    throw new Error('API_PROXY_HOPS must be at least 1 in production (a load balancer in front)');
  const payments = paymentsFrom(env, production);
  const files = filesFrom(env, production);
  // Rider checks (P3.11.2): the providers come with their contracts (P4); a laptop uses fakes that
  // pass at once, so the whole flow can be tried. Production runs without them until then.
  const riderChecks = production
    ? undefined
    : { kyc: fakeKyc({ auto: true }), esign: fakeEsign({ auto: true }), bank: fakeBankCheck() };
  return {
    databaseUrl: need('DATABASE_URL'),
    host: env.API_HOST || '127.0.0.1',
    port: Number(env.API_PORT || 8080),
    secretKey: readKey(keyText),
    origins,
    secureCookies,
    proxyHops,
    ...(payments ? { payments } : {}),
    ...(files ? { files } : {}),
    ...(riderChecks ? { riderChecks } : {}),
  };
}

/**
 * Brand payments (P3.8.2). On a laptop: the fake provider (no keys, no money). A real provider is
 * plugged in at P6 by its keys; until then a production API runs without payments (its pay routes
 * answer that payments are not set up) rather than on the fake. The fake's message key is public in
 * the code, so a server anyone can reach must set its own, or anyone could "pay" a booking.
 */
export function paymentsFrom(
  env: NodeJS.ProcessEnv,
  production: boolean,
): PaymentsAdapter | undefined {
  const provider = env.PAYMENTS_PROVIDER || (production ? '' : 'fake');
  if (provider === '') return undefined;
  if (provider !== 'fake')
    throw new Error(
      `PAYMENTS_PROVIDER ${provider} is not available yet (real providers come in P6)`,
    );
  if (production) throw new Error('The fake payments provider is for a laptop only');
  // Reachable from outside: bound beyond this machine, behind a proxy, or serving an admin site
  // that is not on this machine.
  const loopback = (h: string) => /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(h);
  const host = env.API_HOST || '127.0.0.1';
  const origins = (env.ADMIN_ORIGINS || 'http://localhost:3001').split(',').map((o) => o.trim());
  const local =
    loopback(host) &&
    Number(env.API_PROXY_HOPS || 0) === 0 &&
    origins.every((o) => {
      try {
        return loopback(new URL(o).hostname);
      } catch {
        return false;
      }
    });
  if (!local && !env.PAYMENTS_WEBHOOK_SECRET)
    throw new Error('PAYMENTS_WEBHOOK_SECRET must be set when the API is reachable from outside');
  return fakePayments(env.PAYMENTS_WEBHOOK_SECRET ? { secret: env.PAYMENTS_WEBHOOK_SECRET } : {});
}

/**
 * Ad files (P3.9.1). On a laptop: a fake store in memory (files are lost on a restart), its signed
 * links served by the API through the admin site (`FILES_PUBLIC_URL`). The real store
 * (S3-compatible) comes with the other outside services (P6); until then production has no ad files.
 */
export function filesFrom(env: NodeJS.ProcessEnv, production: boolean): FileStore | undefined {
  if (production) return undefined;
  return fakeFileStore({
    baseUrl: env.FILES_PUBLIC_URL || 'http://localhost:3001/api/files',
    // A fresh key on each start: the fake's files do not outlive the process either.
    secret: randomBytes(32).toString('hex'),
  });
}
