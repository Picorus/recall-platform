// P5.1: brand portal sign-in in the database, as rider sign-in (P4.1) but for a mobile number or an
// email address. A code is asked for (few per address and connection, per day, per connection, and
// for everyone together), sent on WhatsApp, by SMS or by email, kept only as a keyed fingerprint,
// and works for a few minutes and a few tries; only the newest code that was sent counts. A right
// code opens a session for that number or email (its token is kept only as a fingerprint); the
// session lasts until the person signs out, staff end it, or it goes unused for the idle days.
// Which brands and agencies a person may act for is brand_members: checked on every request, so
// access removed by staff ends at once.
import type { MessageResult, MessagesAdapter } from '@recall/adapters';
import {
  brandCodeEmail,
  brandCodeSms,
  DEFAULT_BRAND_SIGN_IN,
  type BrandCodeChannel,
  type BrandMemberRole,
  type BrandSignInRules,
} from '@recall/domain';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;

/** How long the provider has to take a code (then it counts as not sent; the person asks again). */
const SEND_WAIT_MS = 10_000;

const fingerprint = (secret: Buffer, address: string, code: string) =>
  createHmac('sha256', secret).update(`brand-code\n${address}\n${code}`).digest('hex');
export const brandTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The connection's lock, then the address's: always in this order, so two never wait on each other. */
async function lock(c: Q, ip: string, address: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-sign-in-ip:${ip}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-sign-in:${address}`]);
}

/** The start of the India day `now` falls in (UTC seconds). */
const indiaDayStart = (now: number) => {
  const shift = 330 * 60;
  return Math.floor((now + shift) / 86_400) * 86_400 - shift;
};

const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

type Refused = { readonly refused: string; readonly why: { code: string; n?: number } };

/**
 * Sends a sign-in code to a number (WhatsApp or SMS) or an email address (email). Refused (in words
 * the person can act on) when too many have been asked for. Returns when the code stops working.
 */
export async function askBrandCode(
  pool: Pool,
  messages: MessagesAdapter,
  ask: { readonly address: string; readonly channel: BrandCodeChannel; readonly ip: string },
  secret: Buffer,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<{ readonly expiresAt: number }> {
  if ((ask.channel === 'email') !== ask.address.includes('@'))
    throw new RangeError('An email address gets its code by email; a number by WhatsApp or SMS');
  const what = ask.channel === 'email' ? 'email' : 'number';
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const made = await inTransaction(pool, async (c): Promise<Refused | { codeId: string }> => {
    await lock(c, ask.ip, ask.address);
    const all = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM brand_codes WHERE sent_at > to_timestamp($1) - interval '1 hour'`,
      [now],
    );
    if (Number(all.rows[0]?.n ?? 0) >= rules.codesPerHourAll)
      return { refused: 'Sign-in is busy: try again in a few minutes', why: { code: 'busy' } };
    const r = await c.query<{ recent: string; today: string; first: string | null }>(
      `SELECT count(*) FILTER (WHERE ip = $4 AND sent_at > to_timestamp($2) - interval '15 minutes') AS recent,
              count(*) FILTER (WHERE sent_at >= to_timestamp($3)) AS today,
              extract(epoch FROM min(sent_at) FILTER
                (WHERE ip = $4 AND sent_at > to_timestamp($2) - interval '15 minutes'))::bigint AS first
         FROM brand_codes
        WHERE address = $1 AND sent_at >= least(to_timestamp($3), to_timestamp($2) - interval '15 minutes')`,
      [ask.address, now, indiaDayStart(now), ask.ip],
    );
    const counts = r.rows[0];
    if (Number(counts?.today ?? 0) >= rules.codesPerDay)
      return {
        refused: `Too many codes for this ${what} today: try again tomorrow`,
        why: { code: 'too-many-today' },
      };
    if (Number(counts?.recent ?? 0) >= rules.codesPer15Min) {
      const wait = minutes(Number(counts?.first ?? now) + 900 - now);
      return {
        refused: `Too many codes for this ${what}: try again in ${wait} minutes`,
        why: { code: 'too-many-number', n: wait },
      };
    }
    const byIp = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM brand_codes
        WHERE ip = $1 AND sent_at > to_timestamp($2) - interval '1 hour'`,
      [ask.ip, now],
    );
    if (Number(byIp.rows[0]?.n ?? 0) >= rules.codesPerAddressHour)
      return {
        refused: 'Too many codes from this connection: try again in an hour',
        why: { code: 'too-many-connection' },
      };
    const ins = await c.query<{ code_id: string }>(
      `INSERT INTO brand_codes (address, channel, code_hash, ip, sent_at, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6)) RETURNING code_id`,
      [
        ask.address,
        ask.channel,
        fingerprint(secret, ask.address, code),
        ask.ip,
        now,
        now + rules.codeSeconds,
      ],
    );
    return { codeId: ins.rows[0]?.code_id ?? '' };
  });
  if ('refused' in made) throw new Refusal(made.refused, made.why);
  // Sent after the code is written down: its own key, so a retry never sends a second message.
  const key = `brand-code:${made.codeId}`;
  const mins = rules.codeSeconds / 60;
  let timer: NodeJS.Timeout | undefined;
  const failed = (reason: string): MessageResult => ({ status: 'failed', reason, retryable: true });
  const result = await Promise.race([
    messages
      .send(
        ask.channel === 'whatsapp'
          ? {
              channel: 'whatsapp',
              key,
              to: ask.address,
              template: 'sign_in_code',
              language: 'en',
              params: [code],
            }
          : ask.channel === 'sms'
            ? { channel: 'sms', key, to: ask.address, text: brandCodeSms(code, mins) }
            : {
                channel: 'email',
                key,
                to: ask.address,
                ...brandCodeEmail(code, mins),
                attachments: [],
              },
      )
      .catch((e: unknown) => failed(`no answer: ${e instanceof Error ? e.message : String(e)}`)),
    new Promise<MessageResult>((ok) => {
      timer = setTimeout(() => ok(failed('no answer in 10 s')), SEND_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  await pool.query(
    `INSERT INTO brand_code_sends (code_id, status, detail, at) VALUES ($1, $2, $3, to_timestamp($4))`,
    [
      made.codeId,
      result.status,
      (result.status === 'sent' ? result.providerRef : result.reason).slice(0, 200),
      now,
    ],
  );
  if (result.status !== 'sent')
    throw new Refusal(
      ask.channel === 'whatsapp'
        ? 'The code could not be sent on WhatsApp: try SMS, or again in a minute'
        : ask.channel === 'sms'
          ? 'The code could not be sent by SMS: try again in a minute'
          : 'The code could not be sent to this email: check it, or try again in a minute',
      { code: `not-sent-${ask.channel}` },
    );
  return { expiresAt: now + rules.codeSeconds };
}

/**
 * Checks a code typed for a number or email. Right: a new session (its token, given only now).
 * Wrong: refused, saying how many tries are left. Every try is kept, right or wrong.
 */
export async function checkBrandCode(
  pool: Pool,
  typed: { readonly address: string; readonly code: string; readonly ip: string },
  secret: Buffer,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<{ readonly token: string }> {
  const what = typed.address.includes('@') ? 'email' : 'number';
  const out = await inTransaction(pool, async (c): Promise<Refused | { token: string }> => {
    await lock(c, typed.ip, typed.address);
    const wrongByIp = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM brand_code_tries
        WHERE ip = $1 AND NOT ok AND at > to_timestamp($2) - interval '1 hour'`,
      [typed.ip, now],
    );
    if (Number(wrongByIp.rows[0]?.n ?? 0) >= rules.wrongPerAddressHour)
      return {
        refused: 'Too many wrong codes from this connection: try again in an hour',
        why: { code: 'too-many-wrong' },
      };
    const wrongToday = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM brand_code_tries
        WHERE address = $1 AND NOT ok AND code_id IS NOT NULL AND at >= to_timestamp($2)`,
      [typed.address, indiaDayStart(now)],
    );
    if (Number(wrongToday.rows[0]?.n ?? 0) >= rules.wrongPerNumberDay)
      return {
        refused: `Too many wrong codes for this ${what} today: try again tomorrow`,
        why: { code: 'too-many-wrong-number' },
      };
    // Only the newest code that was sent counts (one that failed to go never replaces one that
    // did), while it lasts, is unused and has tries left.
    const live = await c.query<{ code_id: string; code_hash: string; wrong: string }>(
      `SELECT k.code_id, k.code_hash,
              (SELECT count(*) FROM brand_code_tries t WHERE t.code_id = k.code_id AND NOT t.ok) AS wrong
         FROM brand_codes k
        WHERE k.address = $1 AND k.sent_at <= to_timestamp($2) AND k.expires_at > to_timestamp($2)
          AND k.code_id = (SELECT max(x.code_id) FROM brand_codes x
                            WHERE x.address = $1
                              AND NOT EXISTS (SELECT 1 FROM brand_code_sends f
                                               WHERE f.code_id = x.code_id AND f.status = 'failed'))
          AND NOT EXISTS (SELECT 1 FROM brand_code_tries t WHERE t.code_id = k.code_id AND t.ok)`,
      [typed.address, now],
    );
    const code = live.rows[0];
    const wrong = Number(code?.wrong ?? 0);
    const tryRow = (codeId: string | null, ok: boolean) =>
      c.query(
        `INSERT INTO brand_code_tries (code_id, address, ok, ip, at)
         VALUES ($1, $2, $3, $4, to_timestamp($5))`,
        [codeId, typed.address, ok, typed.ip, now],
      );
    if (!code || wrong >= rules.triesPerCode) {
      // Kept, but not counted against the number or the code: no code was live, so it was no
      // guess (a stranger typing codes cannot lock anyone out).
      await tryRow(null, false);
      return {
        refused: 'This code no longer works: ask for a new one',
        why: { code: 'code-dead' },
      };
    }
    const right = timingSafeEqual(
      Buffer.from(code.code_hash, 'hex'),
      Buffer.from(fingerprint(secret, typed.address, typed.code), 'hex'),
    );
    if (!right) {
      await tryRow(code.code_id, false);
      const left = rules.triesPerCode - wrong - 1;
      return {
        refused:
          left > 0
            ? `Wrong code: ${left} ${left === 1 ? 'try' : 'tries'} left`
            : 'Wrong code: ask for a new one',
        why: { code: 'wrong-code', n: left },
      };
    }
    await tryRow(code.code_id, true);
    const token = randomBytes(32).toString('base64url');
    await c.query(
      `INSERT INTO brand_sessions (token_hash, address, code_id, ip, started_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [brandTokenHash(token), typed.address, code.code_id, typed.ip, now],
    );
    return { token };
  });
  // A wrong try is kept (the transaction above is done) before the person is told.
  if ('refused' in out) throw new Refusal(out.refused, out.why);
  return out;
}

export interface BrandSession {
  readonly tokenHash: string;
  /** The number (+91…) or email address signed in with. */
  readonly address: string;
  readonly startedAt: number;
}

/** The session behind a token, if it is still open: not ended and not idle too long. */
export async function brandSession(
  pool: Pool,
  token: string,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<BrandSession | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const hash = brandTokenHash(token);
  const r = await pool.query<{ address: string; started: string; last: string }>(
    `SELECT s.address, extract(epoch FROM s.started_at)::bigint AS started,
            extract(epoch FROM greatest(s.started_at,
              (SELECT max(at) FROM brand_session_seen w WHERE w.token_hash = s.token_hash)))::bigint AS last
       FROM brand_sessions s
      WHERE s.token_hash = $1
        AND NOT EXISTS (SELECT 1 FROM brand_session_ends e WHERE e.token_hash = s.token_hash)`,
    [hash],
  );
  const s = r.rows[0];
  if (!s || now - Number(s.last) > rules.idleDays * 86_400) return undefined;
  // Used now: noted at most once an hour.
  if (now - Number(s.last) >= 3600)
    await pool.query(
      `INSERT INTO brand_session_seen (token_hash, at) VALUES ($1, to_timestamp($2))
       ON CONFLICT DO NOTHING`,
      [hash, now],
    );
  return { tokenHash: hash, address: s.address, startedAt: Number(s.started) };
}

/** Ends a session (the person signs out, or staff end it, with why). Ending it twice is no error. */
export async function endBrandSession(
  pool: Pool,
  session: Pick<BrandSession, 'tokenHash' | 'address'>,
  end: { readonly by: string; readonly why: string },
  now: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO brand_session_ends (token_hash, address, by, why, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT DO NOTHING`,
    [session.tokenHash, session.address, end.by.slice(0, 254), end.why.slice(0, 300), now],
  );
}

export interface PortalAccount {
  readonly brandId: string;
  readonly name: string;
  readonly kind: 'brand' | 'agency';
  readonly role: BrandMemberRole;
}

/**
 * The brands and agencies a number or email may act for now: its latest access to each is on, and
 * the account itself is active.
 */
export async function portalAccounts(c: Q, address: string): Promise<PortalAccount[]> {
  const r = await c.query<{ brand_id: string; name: string; kind: string; role: string }>(
    `SELECT m.brand_id, v.name, b.kind, m.role
       FROM (SELECT DISTINCT ON (brand_id) brand_id, role, active FROM brand_members
              WHERE address = $1 ORDER BY brand_id, version DESC) m
       JOIN brands b USING (brand_id)
       JOIN LATERAL (SELECT name, active FROM brand_versions x WHERE x.brand_id = m.brand_id
                      ORDER BY version DESC LIMIT 1) v ON true
      WHERE m.active AND v.active
      ORDER BY v.name, m.brand_id`,
    [address],
  );
  return r.rows.map((x) => ({
    brandId: x.brand_id,
    name: x.name,
    kind: x.kind as PortalAccount['kind'],
    role: x.role as BrandMemberRole,
  }));
}

export interface PortalMember {
  readonly address: string;
  readonly role: BrandMemberRole;
  readonly active: boolean;
  readonly setBy: string;
  readonly setAt: number;
  readonly reason: string;
}

/** Everyone given portal access to an account, with their latest access (removed ones too). */
export async function portalMembers(c: Q, brandId: string): Promise<PortalMember[]> {
  const r = await c.query<{
    address: string;
    role: string;
    active: boolean;
    set_by: string;
    set_at: Date;
    reason: string;
  }>(
    `SELECT DISTINCT ON (address) address, role, active, set_by, set_at, reason
       FROM brand_members WHERE brand_id = $1 ORDER BY address, version DESC`,
    [brandId],
  );
  return r.rows
    .map((x) => ({
      address: x.address,
      role: x.role as BrandMemberRole,
      active: x.active,
      setBy: x.set_by,
      setAt: Math.floor(x.set_at.getTime() / 1000),
      reason: x.reason,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.address.localeCompare(b.address));
}

/**
 * Gives, changes or removes a person's portal access to an account (a new version; nothing is
 * overwritten). Refused for an account that does not exist, or when nothing would change.
 */
export async function setPortalMember(
  pool: Pool,
  m: {
    readonly brandId: string;
    readonly address: string;
    readonly role: BrandMemberRole;
    readonly active: boolean;
    readonly reason: string;
    readonly by: string;
  },
  now: number,
): Promise<number> {
  return inTransaction(pool, async (c) => {
    await lockMembers(c, m.brandId);
    return setMemberIn(c, m, now);
  });
}

/** One business's people change one at a time (P5.9: checks and the change under one lock). */
export async function lockMembers(c: Q, brandId: string): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-members:${brandId}`]);
}

/** setPortalMember's change, inside the caller's transaction holding `lockMembers`. */
export async function setMemberIn(
  c: Q,
  m: {
    readonly brandId: string;
    readonly address: string;
    readonly role: BrandMemberRole;
    readonly active: boolean;
    readonly reason: string;
    readonly by: string;
  },
  now: number,
): Promise<number> {
  {
    const b = await c.query('SELECT 1 FROM brands WHERE brand_id = $1', [m.brandId]);
    if (b.rowCount === 0) throw new Refusal('No such brand or agency');
    const last = await c.query<{ version: number; role: string; active: boolean }>(
      `SELECT version, role, active FROM brand_members WHERE brand_id = $1 AND address = $2
        ORDER BY version DESC LIMIT 1`,
      [m.brandId, m.address],
    );
    const x = last.rows[0];
    if (!x && !m.active) throw new Refusal('This person has no access to remove');
    if (x && x.active === m.active && (x.role === m.role || !m.active))
      throw new Refusal(
        m.active ? 'They already have this access' : 'Their access is already removed',
      );
    const version = (x?.version ?? 0) + 1;
    await c.query(
      `INSERT INTO brand_members (brand_id, address, version, role, active, reason, set_by, set_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
      [m.brandId, m.address, version, m.role, m.active, m.reason, m.by, now],
    );
    return version;
  }
}
