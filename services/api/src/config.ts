// The API's settings from the environment (names in .env.example; values never in the repository).
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
  return {
    databaseUrl: need('DATABASE_URL'),
    host: env.API_HOST || '127.0.0.1',
    port: Number(env.API_PORT || 8080),
    secretKey: readKey(keyText),
    origins,
    secureCookies,
    trustProxy: env.API_TRUST_PROXY === 'yes',
  };
}
