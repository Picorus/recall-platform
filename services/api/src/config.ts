// The API's settings from the environment (names in .env.example; values never in the repository).
import {
  fakeBankCheck,
  fakeEsign,
  fakeFileStore,
  fakeKyc,
  fakeMaps,
  fakeMessages,
  fakePayments,
  fakePayouts,
  type FileStore,
  type MapsAdapter,
  type MessagesAdapter,
  type PaymentsAdapter,
  type PayoutsAdapter,
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
  const riderChecks = riderChecksFrom(env, production);
  const payouts = payoutsFrom(env, production);
  const reports = reportsFrom(env, production);
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
    ...(payouts ? { payouts } : {}),
    ...(reports ? { reports } : {}),
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

/** The API can be reached only from this machine (bound to loopback, no proxy, a local admin site). */
function onlyLocal(env: NodeJS.ProcessEnv): boolean {
  const loopback = (h: string) => /^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(h);
  const origins = (env.ADMIN_ORIGINS || 'http://localhost:3001').split(',').map((o) => o.trim());
  return (
    loopback(env.API_HOST || '127.0.0.1') &&
    Number(env.API_PROXY_HOPS || 0) === 0 &&
    origins.every((o) => {
      try {
        return loopback(new URL(o).hostname);
      } catch {
        return false;
      }
    })
  );
}

/**
 * Rider checks (P3.11.2): identity, e-sign, bank. The providers come with their contracts (P4);
 * until then no rider can be approved outside a laptop. On a laptop (only one nobody else can reach)
 * the fakes pass at once, so the whole flow can be tried: anywhere else they would let anyone through.
 */
export function riderChecksFrom(
  env: NodeJS.ProcessEnv,
  production: boolean,
): StaffApiConfig['riderChecks'] {
  const provider = env.RIDER_CHECKS_PROVIDER || (production ? '' : 'fake');
  if (provider === '') return undefined;
  if (provider !== 'fake')
    throw new Error(
      `RIDER_CHECKS_PROVIDER ${provider} is not available yet (real ones come in P4)`,
    );
  if (production || !onlyLocal(env))
    throw new Error('The fake rider checks are for a laptop only (nobody else can reach it)');
  return { kyc: fakeKyc({ auto: true }), esign: fakeEsign({ auto: true }), bank: fakeBankCheck() };
}

/**
 * Paying riders (P3.12). The real payout provider comes with its contract (P6); until then a
 * production API prepares and approves runs but cannot send them. On a laptop (only one nobody else
 * can reach) the fake pays at once, so the whole run can be tried.
 */
export function payoutsFrom(
  env: NodeJS.ProcessEnv,
  production: boolean,
): PayoutsAdapter | undefined {
  const provider = env.PAYOUTS_PROVIDER || (production ? '' : 'fake');
  if (provider === '') return undefined;
  if (provider !== 'fake')
    throw new Error(
      `PAYOUTS_PROVIDER ${provider} is not available yet (real providers come in P6)`,
    );
  if (production || !onlyLocal(env))
    throw new Error('The fake payout provider is for a laptop only (nobody else can reach it)');
  return fakePayouts();
}

/**
 * Final campaign reports (P3.14.1): street names (maps), sending to brands (WhatsApp and email) and
 * where the brand opens its report (`BRAND_PORTAL_URL`). The real providers come with their accounts
 * (P6); until then production builds and sends no reports. On a laptop (only one nobody else can
 * reach) the fakes stand in: nothing leaves the machine.
 */
export function reportsFrom(
  env: NodeJS.ProcessEnv,
  production: boolean,
): StaffApiConfig['reports'] {
  const provider = env.REPORTS_PROVIDER || (production ? '' : 'fake');
  if (provider === '') return undefined;
  if (provider !== 'fake')
    throw new Error(
      `REPORTS_PROVIDER ${provider} is not available yet (real providers come in P6)`,
    );
  if (production || !onlyLocal(env))
    throw new Error('The fake maps and messages are for a laptop only (nobody else can reach it)');
  const portal = (env.BRAND_PORTAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const maps: MapsAdapter = fakeMaps();
  const messages: MessagesAdapter = fakeMessages();
  return { maps, messages, portalUrl: portal };
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
