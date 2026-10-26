// Resets a member's password and two-step code from the server itself, for when no super admin can
// sign in (the only one lost their phone, or their account stopped after wrong codes):
//   pnpm --filter @recall/api reset-staff <email>
// Prints a new invite link; the old password stops working at once. Logged as made by 'server'.
import { resetStaffOnServer } from '@recall/db';
import { DEFAULT_SIGN_IN_RULES } from '@recall/domain';
import pg from 'pg';
import { readConfig } from './config.js';
import { newToken, newTotpSecret, seal, tokenHash } from './secrets.js';

const [email] = process.argv.slice(2);
if (!email) {
  console.error('Usage: reset-staff <email>');
  process.exit(2);
}
const cfg = readConfig();
const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
const token = newToken();
const nowMs = Date.now();
try {
  const m = await resetStaffOnServer(pool, {
    email,
    invite: {
      tokenHash: tokenHash(token),
      totpSealed: seal(cfg.secretKey, newTotpSecret()),
      untilMs: nowMs + DEFAULT_SIGN_IN_RULES.inviteMs,
    },
    nowMs,
  });
  console.log(
    `${m.name}: new invite (valid 48 hours, once): ${cfg.origins[0] ?? ''}/invite#t=${token}`,
  );
} finally {
  await pool.end();
}
