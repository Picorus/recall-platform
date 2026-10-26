// Makes the first super admin on a new database (run once, on the server):
//   pnpm --filter @recall/api first-admin <email> "<name>"
// Prints the invite link's token: open /invite#t=<token> on the admin site to set the password and
// two-step code. Refused once any staff exist (then a super admin adds people in the admin site).
import { addStaff } from '@recall/db';
import pg from 'pg';
import { readConfig } from './config.js';
import { newToken, newTotpSecret, seal, tokenHash } from './secrets.js';
import { DEFAULT_SIGN_IN_RULES } from '@recall/domain';

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: first-admin <email> "<name>"');
  process.exit(2);
}
const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
const token = newToken();
const nowMs = Date.now();
try {
  await addStaff(pool, {
    email,
    name,
    access: { role: 'super-admin', areas: [] },
    byId: 'setup',
    reason: 'first super admin',
    invite: {
      tokenHash: tokenHash(token),
      totpSealed: seal(cfg.secretKey, newTotpSecret()),
      untilMs: nowMs + DEFAULT_SIGN_IN_RULES.inviteMs,
    },
    nowMs,
  });
  console.log(`Invite (valid 48 hours, once): ${cfg.origins[0] ?? ''}/invite#t=${token}`);
} finally {
  await pool.end();
}
