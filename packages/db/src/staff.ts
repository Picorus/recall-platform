// P3.1 in the database: staff, their access, invites, sign-in tries and sessions. The secret work
// (password hashes, two-step codes, encryption) is done by the API (services/api/src/secrets.ts);
// this keeps the records and the rules that need them: who may change access, the lock after wrong
// tries, a code used once, sessions ending. Every check of who is asking is made again here, inside
// the transaction, from the stored access, never from what the caller says.
import {
  accessProblem,
  can,
  DEFAULT_SIGN_IN_RULES,
  isEmail,
  lockedUntil,
  normalEmail,
  sessionAlive,
  type SignInRules,
  type StaffAccess,
  type StaffArea,
  type StaffRole,
} from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';

type Q = Pick<PoolClient, 'query'>;

export interface StaffMember {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly access: StaffAccess;
  readonly active: boolean;
}

/** A new invite, made by the API (only the token's hash and the sealed two-step secret). */
export interface NewInvite {
  readonly tokenHash: string;
  readonly totpSealed: string;
  readonly untilMs: number;
}

export type EndWhy = 'signed-out' | 'access-changed' | 'reset' | 'switched-off';

const LOCK = "SELECT pg_advisory_xact_lock(hashtext('recall-staff'))";
const ts = (ms: number) => ms / 1000;

interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  areas: StaffArea[];
  active: boolean;
}

const member = (r: MemberRow): StaffMember => ({
  id: r.id,
  email: r.email,
  name: r.name,
  access: { role: r.role, areas: r.areas },
  active: r.active,
});

const MEMBERS = `
  SELECT s.id, s.email, s.name, a.role, a.areas, a.active
    FROM staff s
    JOIN LATERAL (SELECT role, areas, active FROM staff_access WHERE staff_id = s.id
                   ORDER BY id DESC LIMIT 1) a ON true`;

export async function staffMember(c: Q, id: string): Promise<StaffMember | undefined> {
  const r = await c.query<MemberRow>(`${MEMBERS} WHERE s.id = $1`, [id]);
  return r.rows[0] && member(r.rows[0]);
}

async function staffByEmail(c: Q, email: string): Promise<StaffMember | undefined> {
  const r = await c.query<MemberRow>(`${MEMBERS} WHERE s.email = $1`, [normalEmail(email)]);
  return r.rows[0] && member(r.rows[0]);
}

/** Everyone, for the super admin's staff page. */
export async function staffList(c: Q): Promise<StaffMember[]> {
  const r = await c.query<MemberRow>(`${MEMBERS} ORDER BY s.added_at, s.id`);
  return r.rows.map(member);
}

/** The asking member, active and a super admin, or an error. */
async function superAdmin(c: Q, byId: string): Promise<StaffMember> {
  const by = await staffMember(c, byId);
  if (!by || !by.active || !can(by.access, { superAdmin: true }))
    throw new Error('Only a super admin can change staff');
  return by;
}

async function activeSuperAdmins(c: Q): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM (${MEMBERS}) m WHERE m.role = 'super-admin' AND m.active`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

function checkReason(reason: string): string {
  const t = reason.trim();
  if (t.length < 3 || t.length > 200) throw new RangeError('Give a reason (3 to 200 characters)');
  return t;
}

async function insertInvite(c: Q, staffId: string, invite: NewInvite, by: string, nowMs: number) {
  if (!/^[0-9a-f]{64}$/.test(invite.tokenHash)) throw new RangeError('bad invite');
  if (invite.untilMs <= nowMs) throw new RangeError('invite already expired');
  await c.query(
    `INSERT INTO staff_invites (token_hash, staff_id, totp_secret, made_at, until, by)
     VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), $6)`,
    [invite.tokenHash, staffId, invite.totpSealed, ts(nowMs), ts(invite.untilMs), by],
  );
}

async function endAllSessions(c: Q, staffId: string, why: EndWhy, nowMs: number) {
  await c.query(
    `INSERT INTO staff_session_ends (token_hash, at, why)
     SELECT s.token_hash, to_timestamp($2), $3 FROM staff_sessions s
      WHERE s.staff_id = $1
        AND NOT EXISTS (SELECT 1 FROM staff_session_ends e WHERE e.token_hash = s.token_hash)`,
    [staffId, ts(nowMs), why],
  );
}

/**
 * Adds a member with their first invite. `byId` must be an active super admin, except for the very
 * first member (`byId` 'setup', when there is no staff yet), who must be a super admin.
 */
export async function addStaff(
  pool: Pool,
  o: {
    readonly email: string;
    readonly name: string;
    readonly access: StaffAccess;
    readonly byId: string;
    readonly reason: string;
    readonly invite: NewInvite;
    readonly nowMs: number;
  },
): Promise<StaffMember> {
  const email = normalEmail(o.email);
  if (!isEmail(email)) throw new RangeError('Not an email address');
  const name = o.name.trim();
  if (name.length < 1 || name.length > 80)
    throw new RangeError('Give a name (up to 80 characters)');
  const problem = accessProblem(o.access);
  if (problem) throw new RangeError(`Access: ${problem}`);
  const reason = checkReason(o.reason);
  const access: StaffAccess = { role: o.access.role, areas: [...new Set(o.access.areas)] };
  return inTransaction(pool, async (c) => {
    await c.query(LOCK);
    if (o.byId === 'setup') {
      const n = await c.query<{ n: string }>('SELECT count(*) AS n FROM staff');
      if (Number(n.rows[0]?.n) > 0) throw new Error('Staff already exist: a super admin adds more');
      if (access.role !== 'super-admin') throw new Error('The first member must be a super admin');
    } else {
      await superAdmin(c, o.byId);
    }
    if (await staffByEmail(c, email)) throw new Error('That email already has an account');
    const id = `STF-${randomBytes(6).toString('hex')}`;
    await c.query(
      'INSERT INTO staff (id, email, name, added_at, added_by) VALUES ($1, $2, $3, to_timestamp($4), $5)',
      [id, email, name, ts(o.nowMs), o.byId],
    );
    await c.query(
      `INSERT INTO staff_access (staff_id, role, areas, active, at, by, reason)
       VALUES ($1, $2, $3, true, to_timestamp($4), $5, $6)`,
      [id, access.role, access.areas, ts(o.nowMs), o.byId, reason],
    );
    await insertInvite(c, id, o.invite, o.byId, o.nowMs);
    return { id, email, name, access, active: true };
  });
}

/**
 * A super admin changes a member's role and areas, or switches them off or on. Their sessions end
 * (they sign in again with the new access). The last active super admin cannot be taken away.
 */
export async function changeAccess(
  pool: Pool,
  o: {
    readonly staffId: string;
    readonly access: StaffAccess;
    readonly active: boolean;
    readonly byId: string;
    readonly reason: string;
    readonly nowMs: number;
  },
): Promise<StaffMember> {
  const problem = accessProblem(o.access);
  if (problem) throw new RangeError(`Access: ${problem}`);
  const reason = checkReason(o.reason);
  const access: StaffAccess = { role: o.access.role, areas: [...new Set(o.access.areas)] };
  return inTransaction(pool, async (c) => {
    await c.query(LOCK);
    await superAdmin(c, o.byId);
    const before = await staffMember(c, o.staffId);
    if (!before) throw new Error('No such member');
    const wasSuper = before.active && before.access.role === 'super-admin';
    const staysSuper = o.active && access.role === 'super-admin';
    if (wasSuper && !staysSuper && (await activeSuperAdmins(c)) <= 1)
      throw new Error('There must always be one active super admin');
    await c.query(
      `INSERT INTO staff_access (staff_id, role, areas, active, at, by, reason)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7)`,
      [o.staffId, access.role, access.areas, o.active, ts(o.nowMs), o.byId, reason],
    );
    await endAllSessions(c, o.staffId, o.active ? 'access-changed' : 'switched-off', o.nowMs);
    return { ...before, access, active: o.active };
  });
}

/**
 * A super admin resets a member's password and two-step code (a lost phone, a forgotten password):
 * their sessions end and the old password stops working at once; they set new ones from the invite.
 */
export async function resetStaff(
  pool: Pool,
  o: {
    readonly staffId: string;
    readonly byId: string;
    readonly invite: NewInvite;
    readonly nowMs: number;
  },
): Promise<void> {
  await inTransaction(pool, async (c) => {
    await c.query(LOCK);
    await superAdmin(c, o.byId);
    if (!(await staffMember(c, o.staffId))) throw new Error('No such member');
    await insertInvite(c, o.staffId, o.invite, o.byId, o.nowMs);
    await endAllSessions(c, o.staffId, 'reset', o.nowMs);
  });
}

export interface OpenInvite {
  readonly staffId: string;
  readonly email: string;
  readonly name: string;
  readonly totpSealed: string;
}

/** An invite that can still be used: not used, not expired, the member's newest, member active. */
export async function openInvite(
  c: Q,
  tokenHash: string,
  nowMs: number,
): Promise<OpenInvite | undefined> {
  const r = await c.query<{ staff_id: string; email: string; name: string; totp_secret: string }>(
    `SELECT i.staff_id, s.email, s.name, i.totp_secret
       FROM staff_invites i JOIN staff s ON s.id = i.staff_id
      WHERE i.token_hash = $1 AND i.until > to_timestamp($2)
        AND NOT EXISTS (SELECT 1 FROM staff_credentials c WHERE c.invite_hash = i.token_hash)
        AND i.n = (SELECT max(n) FROM staff_invites WHERE staff_id = i.staff_id)
        AND (SELECT active FROM staff_access WHERE staff_id = i.staff_id ORDER BY id DESC LIMIT 1)`,
    [tokenHash, ts(nowMs)],
  );
  const x = r.rows[0];
  return x && { staffId: x.staff_id, email: x.email, name: x.name, totpSealed: x.totp_secret };
}

/**
 * Sets the password and two-step secret from an invite (once). The API has checked the new password
 * and that the member's app shows the right code. Returns false when the invite cannot be used.
 */
export async function acceptInvite(
  pool: Pool,
  tokenHash: string,
  passwordHash: string,
  nowMs: number,
): Promise<boolean> {
  return inTransaction(pool, async (c) => {
    await c.query(LOCK);
    const inv = await openInvite(c, tokenHash, nowMs);
    if (!inv) return false;
    await c.query(
      `INSERT INTO staff_credentials (staff_id, invite_hash, password_hash, totp_secret, at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [inv.staffId, tokenHash, passwordHash, inv.totpSealed, ts(nowMs)],
    );
    return true;
  });
}

/** What the API checks a sign-in against. */
export interface StoredCredentials {
  readonly passwordHash: string;
  readonly totpSealed: string;
  /** The newest two-step step already used: a code is good once. */
  readonly usedUpTo: number;
}

export type SignInResult =
  | { readonly ok: true; readonly member: StaffMember }
  | {
      readonly ok: false;
      readonly why: 'wrong' | 'locked' | 'too-many-here';
      readonly until?: number;
    };

/** Wrong tries from one address in the lock time before it must wait (many accounts guessed). */
const MAX_FAILURES_PER_IP = 30;

/**
 * One sign-in try. `check` is the API's secret check: given the stored credentials (or undefined
 * for an unknown or switched-off member: it must still take the same time), it returns the two-step
 * step used, or undefined when the password or code is wrong. On success a session starts with
 * `sessionHash`. Every try is recorded.
 */
export async function signIn(
  pool: Pool,
  o: {
    readonly email: string;
    readonly ip: string;
    readonly agent: string;
    readonly sessionHash: string;
    readonly nowMs: number;
    readonly check: (cred: StoredCredentials | undefined) => Promise<number | undefined>;
    readonly rules?: SignInRules;
  },
): Promise<SignInResult> {
  const rules = o.rules ?? DEFAULT_SIGN_IN_RULES;
  const email = normalEmail(o.email).slice(0, 254);
  const ip = o.ip.slice(0, 64);
  return inTransaction(pool, async (c) => {
    // One try at a time per email: two at once could both pass the lock check.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recall-sign-in:${email}`]);
    const log = (staffId: string | null, ok: boolean, why: string, step: number | null = null) =>
      c.query(
        `INSERT INTO staff_sign_ins (email, staff_id, ok, why, totp_step, ip, at)
         VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
        [email, staffId, ok, why, step, ip, ts(o.nowMs)],
      );
    const fromIp = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM staff_sign_ins
        WHERE ip = $1 AND NOT ok AND why = 'wrong' AND at > to_timestamp($2)`,
      [ip, ts(o.nowMs - rules.lockMs)],
    );
    if (Number(fromIp.rows[0]?.n) >= MAX_FAILURES_PER_IP) {
      await log(null, false, 'too-many-here');
      return { ok: false, why: 'too-many-here' };
    }
    const m = await staffByEmail(c, email);
    // Wrong tries since the last good sign-in (tries refused while locked do not add to the lock).
    const fails = m
      ? await c.query<{ at: string }>(
          `SELECT (extract(epoch FROM at) * 1000)::bigint AS at FROM staff_sign_ins
            WHERE staff_id = $1 AND NOT ok AND why = 'wrong'
              AND id > coalesce((SELECT max(id) FROM staff_sign_ins WHERE staff_id = $1 AND ok), 0)
            ORDER BY id`,
          [m.id],
        )
      : { rows: [] };
    const until = lockedUntil(
      fails.rows.map((x) => Number(x.at)),
      o.nowMs,
      rules,
    );
    if (m && until !== undefined) {
      await log(m.id, false, 'locked');
      return { ok: false, why: 'locked', until };
    }
    // Only credentials set from the member's newest invite count: a reset stops the old ones.
    const cred = m?.active
      ? await c.query<{ password_hash: string; totp_secret: string; used: string | null }>(
          `SELECT k.password_hash, k.totp_secret,
                  (SELECT max(totp_step) FROM staff_sign_ins WHERE staff_id = k.staff_id AND ok) AS used
             FROM staff_credentials k
            WHERE k.staff_id = $1
              AND k.invite_hash = (SELECT token_hash FROM staff_invites WHERE staff_id = $1
                                    ORDER BY n DESC LIMIT 1)`,
          [m.id],
        )
      : { rows: [] };
    const k = cred.rows[0];
    const step = await o.check(
      k && {
        passwordHash: k.password_hash,
        totpSealed: k.totp_secret,
        usedUpTo: k.used === null ? -1 : Number(k.used),
      },
    );
    if (!m || !k || step === undefined) {
      await log(m?.id ?? null, false, 'wrong');
      return { ok: false, why: 'wrong' };
    }
    await log(m.id, true, 'ok', step);
    await c.query(
      `INSERT INTO staff_sessions (token_hash, staff_id, started_at, ip, agent)
       VALUES ($1, $2, to_timestamp($3), $4, $5)`,
      [o.sessionHash, m.id, ts(o.nowMs), ip, o.agent.slice(0, 300)],
    );
    return { ok: true, member: m };
  });
}

/**
 * The member behind a session, or undefined when it has ended, run out, gone idle, or the member was
 * switched off. Notes the session as seen (at most once a minute).
 */
export async function sessionMember(
  pool: Pick<Pool, 'query'>,
  sessionHash: string,
  nowMs: number,
  rules: SignInRules = DEFAULT_SIGN_IN_RULES,
): Promise<StaffMember | undefined> {
  const r = await pool.query<{ staff_id: string; started: string; seen: string }>(
    `SELECT s.staff_id, (extract(epoch FROM s.started_at) * 1000)::bigint AS started,
            (extract(epoch FROM greatest(s.started_at,
              coalesce((SELECT max(at) FROM staff_session_seen WHERE token_hash = s.token_hash),
                       s.started_at))) * 1000)::bigint AS seen
       FROM staff_sessions s
      WHERE s.token_hash = $1
        AND NOT EXISTS (SELECT 1 FROM staff_session_ends e WHERE e.token_hash = s.token_hash)`,
    [sessionHash],
  );
  const x = r.rows[0];
  if (!x || !sessionAlive(Number(x.started), Number(x.seen), nowMs, rules)) return undefined;
  const m = await staffMember(pool, x.staff_id);
  if (!m?.active) return undefined;
  if (nowMs - Number(x.seen) >= 60_000)
    await pool.query(
      `INSERT INTO staff_session_seen (token_hash, at) VALUES ($1, to_timestamp($2))
       ON CONFLICT DO NOTHING`,
      [sessionHash, ts(nowMs)],
    );
  return m;
}

/** Ends a session (signing out). True when it was open. */
export async function endSession(
  pool: Pick<Pool, 'query'>,
  sessionHash: string,
  why: EndWhy,
  nowMs: number,
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO staff_session_ends (token_hash, at, why)
     SELECT token_hash, to_timestamp($2), $3 FROM staff_sessions WHERE token_hash = $1
     ON CONFLICT DO NOTHING`,
    [sessionHash, ts(nowMs), why],
  );
  return (r.rowCount ?? 0) > 0;
}
