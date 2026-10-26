// Test helper: members with a given access, signed in, for route tests (no passwords or codes).
import { acceptInvite, addStaff, signIn } from '@recall/db';
import type { StaffAccess } from '@recall/domain';
import type pg from 'pg';
import { expect } from 'vitest';
import { newToken, tokenHash } from '../../src/secrets.js';

export function members(pool: () => pg.Pool, NOW: number) {
  let superId = '';
  /** A member with this access, signed in: their session cookie. */
  return async function member(email: string, access: StaffAccess): Promise<string> {
    const invite = newToken();
    const m = await addStaff(pool(), {
      email,
      name: email.split('@')[0] ?? 'x',
      access,
      byId: superId || 'setup',
      reason: 'route test',
      invite: { tokenHash: tokenHash(invite), totpSealed: 'unused', untilMs: NOW + 3_600_000 },
      nowMs: NOW,
    });
    if (!superId) superId = m.id;
    await acceptInvite(pool(), {
      tokenHash: tokenHash(invite),
      passwordHash: 'scrypt$test',
      totpStep: 0,
      nowMs: NOW,
    });
    const session = newToken();
    const r = await signIn(pool(), {
      email,
      ip: '192.0.2.1',
      agent: 'test',
      sessionHash: tokenHash(session),
      nowMs: NOW + 1000,
      check: async () => ({ passwordOk: true, step: 1 }),
    });
    expect(r.ok).toBe(true);
    return `__Host-recall_staff=${session}`;
  };
}
