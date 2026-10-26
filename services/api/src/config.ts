// The API's settings from the environment (names in .env.example; values never in the repository).
import { fakePayments, type PaymentsAdapter } from '@recall/adapters';
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
  return {
    databaseUrl: need('DATABASE_URL'),
    host: env.API_HOST || '127.0.0.1',
    port: Number(env.API_PORT || 8080),
    secretKey: readKey(keyText),
    origins,
    secureCookies,
    proxyHops,
    ...(payments ? { payments } : {}),
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
  const host = env.API_HOST || '127.0.0.1';
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!local && !env.PAYMENTS_WEBHOOK_SECRET)
    throw new Error('PAYMENTS_WEBHOOK_SECRET must be set when the API is reachable from outside');
  return fakePayments(env.PAYMENTS_WEBHOOK_SECRET ? { secret: env.PAYMENTS_WEBHOOK_SECRET } : {});
}
