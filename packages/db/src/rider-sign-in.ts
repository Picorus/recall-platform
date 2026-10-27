// P4.1: rider sign-in in the database. A code is asked for (few per number, per day and per
// connection), sent on WhatsApp or by SMS, kept only as a keyed fingerprint, and works for a few
// minutes and a few tries; only the newest code for a number counts. A right code opens a session
// (its token is kept only as a fingerprint); the session lasts until the rider signs out, staff end
// it, or it goes unused for the idle days.
import type { MessagesAdapter } from '@recall/adapters';
import {
  DEFAULT_RIDER_SIGN_IN,
  riderCodeSms,
  type CodeChannel,
  type RiderLanguage,
  type RiderSignInRules,
} from '@recall/domain';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;

const fingerprint = (secret: Buffer, phone: string, code: string) =>
  createHmac('sha256', secret).update(`rider-code\n${phone}\n${code}`).digest('hex');
export const riderTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const lockKey = (phone: string) => `rider-sign-in:${phone}`;

/** The start of the India day `now` falls in (UTC seconds). */
const indiaDayStart = (now: number) => {
  const shift = 330 * 60;
  return Math.floor((now + shift) / 86_400) * 86_400 - shift;
};

const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

/**
 * Sends a sign-in code to a number. Refused (in words the rider can act on) when that number or
 * that connection has asked for too many. Returns when the code stops working.
 */
export async function askRiderCode(
  pool: Pool,
  messages: MessagesAdapter,
  ask: {
    readonly phone: string;
    readonly channel: CodeChannel;
    readonly ip: string;
    readonly language: RiderLanguage;
  },
  secret: Buffer,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<{ readonly expiresAt: number }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const made = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(ask.phone)]);
    const r = await c.query<{ recent: string; today: string; first: string | null }>(
      `SELECT count(*) FILTER (WHERE sent_at > to_timestamp($2) - interval '15 minutes') AS recent,
              count(*) FILTER (WHERE sent_at >= to_timestamp($3)) AS today,
              extract(epoch FROM min(sent_at) FILTER (WHERE sent_at > to_timestamp($2) - interval '15 minutes'))::bigint AS first
         FROM rider_codes WHERE phone = $1 AND sent_at >= least(to_timestamp($3), to_timestamp($2) - interval '15 minutes')`,
      [ask.phone, now, indiaDayStart(now)],
    );
    const counts = r.rows[0];
    if (Number(counts?.today ?? 0) >= rules.codesPerDay)
      return {
        refused: 'Too many codes for this number today: try again tomorrow',
        why: { code: 'too-many-today' },
      };
    if (Number(counts?.recent ?? 0) >= rules.codesPer15Min) {
      const wait = minutes(Number(counts?.first ?? now) + 900 - now);
      return {
        refused: `Too many codes for this number: try again in ${wait} minutes`,
        why: { code: 'too-many-number', n: wait },
      };
    }
    const byIp = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM rider_codes
        WHERE ip = $1 AND sent_at > to_timestamp($2) - interval '1 hour'`,
      [ask.ip, now],
    );
    if (Number(byIp.rows[0]?.n ?? 0) >= rules.codesPerAddressHour)
      return {
        refused: 'Too many codes from this connection: try again in an hour',
        why: { code: 'too-many-connection' },
      };
    const ins = await c.query<{ code_id: string }>(
      `INSERT INTO rider_codes (phone, channel, code_hash, ip, sent_at, expires_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6)) RETURNING code_id`,
      [
        ask.phone,
        ask.channel,
        fingerprint(secret, ask.phone, code),
        ask.ip,
        now,
        now + rules.codeSeconds,
      ],
    );
    return { codeId: ins.rows[0]?.code_id ?? '' };
  });
  if ('refused' in made) throw new Refusal(made.refused ?? '', made.why);
  // Sent after the code is written down: its own key, so a retry never sends a second message.
  const key = `rider-code:${made.codeId}`;
  const result = await messages
    .send(
      ask.channel === 'whatsapp'
        ? {
            channel: 'whatsapp',
            key,
            to: ask.phone,
            template: 'sign_in_code',
            language: ask.language,
            params: [code],
          }
        : {
            channel: 'sms',
            key,
            to: ask.phone,
            text: riderCodeSms(ask.language, code, rules.codeSeconds / 60),
          },
    )
    .catch(
      (e: unknown) =>
        ({
          status: 'failed',
          reason: `no answer: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
        }) as const,
    );
  await pool.query(
    `INSERT INTO rider_code_sends (code_id, status, detail, at) VALUES ($1, $2, $3, to_timestamp($4))`,
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
        : 'The code could not be sent by SMS: try again in a minute',
      { code: ask.channel === 'whatsapp' ? 'not-sent-whatsapp' : 'not-sent-sms' },
    );
  return { expiresAt: now + rules.codeSeconds };
}

/** The rider whose details now carry this number (the newest, if ever more than one). */
export async function riderForPhone(c: Q, phone: string): Promise<string | null> {
  const r = await c.query<{ rider_id: string }>(
    `SELECT v.rider_id FROM riders r
       JOIN LATERAL (SELECT rider_id, phone FROM rider_versions x WHERE x.rider_id = r.rider_id
                      ORDER BY version DESC LIMIT 1) v ON true
      WHERE v.phone = $1 ORDER BY r.created_at DESC, r.rider_id DESC LIMIT 1`,
    [phone],
  );
  return r.rows[0]?.rider_id ?? null;
}

/**
 * Checks a code typed for a number. Right: a new session (its token, given only now) and the rider
 * the number belongs to (none: a new rider, who signs up next). Wrong: refused, saying how many
 * tries are left. Every try is kept, right or wrong.
 */
export async function checkRiderCode(
  pool: Pool,
  typed: { readonly phone: string; readonly code: string; readonly ip: string },
  secret: Buffer,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<{ readonly token: string; readonly riderId: string | null }> {
  const out = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(typed.phone)]);
    const wrongByIp = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM rider_code_tries
        WHERE ip = $1 AND NOT ok AND at > to_timestamp($2) - interval '1 hour'`,
      [typed.ip, now],
    );
    if (Number(wrongByIp.rows[0]?.n ?? 0) >= rules.wrongPerAddressHour)
      return {
        refused: 'Too many wrong codes from this connection: try again in an hour',
        why: { code: 'too-many-wrong' },
      };
    // Only the newest code for the number counts, while it lasts, is unused and has tries left.
    const live = await c.query<{ code_id: string; code_hash: string; wrong: string }>(
      `SELECT k.code_id, k.code_hash,
              (SELECT count(*) FROM rider_code_tries t WHERE t.code_id = k.code_id AND NOT t.ok) AS wrong
         FROM rider_codes k
        WHERE k.phone = $1 AND k.sent_at <= to_timestamp($2) AND k.expires_at > to_timestamp($2)
          AND k.code_id = (SELECT max(code_id) FROM rider_codes WHERE phone = $1)
          AND NOT EXISTS (SELECT 1 FROM rider_code_tries t WHERE t.code_id = k.code_id AND t.ok)`,
      [typed.phone, now],
    );
    const code = live.rows[0];
    const wrong = Number(code?.wrong ?? 0);
    const tryRow = (codeId: string | null, ok: boolean) =>
      c.query(
        `INSERT INTO rider_code_tries (code_id, phone, ok, ip, at)
         VALUES ($1, $2, $3, $4, to_timestamp($5))`,
        [codeId, typed.phone, ok, typed.ip, now],
      );
    if (!code || wrong >= rules.triesPerCode) {
      await tryRow(code?.code_id ?? null, false);
      return {
        refused: 'This code no longer works: ask for a new one',
        why: { code: 'code-dead' },
      };
    }
    const right = timingSafeEqual(
      Buffer.from(code.code_hash, 'hex'),
      Buffer.from(fingerprint(secret, typed.phone, typed.code), 'hex'),
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
      `INSERT INTO rider_sessions (token_hash, phone, code_id, ip, started_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [riderTokenHash(token), typed.phone, code.code_id, typed.ip, now],
    );
    return { token, riderId: await riderForPhone(c, typed.phone) };
  });
  // A wrong try is kept (the transaction above is done) before the rider is told.
  if ('refused' in out) throw new Refusal(out.refused ?? '', out.why);
  return out;
}

export interface RiderSession {
  readonly tokenHash: string;
  readonly phone: string;
  /** Null: a new number, not yet signed up. */
  readonly riderId: string | null;
  readonly startedAt: number;
}

/** The session behind a token, if it is still open (not ended, not idle too long). */
export async function riderSession(
  pool: Pool,
  token: string,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<RiderSession | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const hash = riderTokenHash(token);
  const r = await pool.query<{ phone: string; started: string; last: string }>(
    `SELECT s.phone, extract(epoch FROM s.started_at)::bigint AS started,
            extract(epoch FROM greatest(s.started_at,
              (SELECT max(at) FROM rider_session_seen w WHERE w.token_hash = s.token_hash)))::bigint AS last
       FROM rider_sessions s
      WHERE s.token_hash = $1
        AND NOT EXISTS (SELECT 1 FROM rider_session_ends e WHERE e.token_hash = s.token_hash)`,
    [hash],
  );
  const s = r.rows[0];
  if (!s || now - Number(s.last) > rules.idleDays * 86_400) return undefined;
  // Used now: noted at most once an hour.
  if (now - Number(s.last) >= 3600)
    await pool.query(
      `INSERT INTO rider_session_seen (token_hash, at) VALUES ($1, to_timestamp($2))
       ON CONFLICT DO NOTHING`,
      [hash, now],
    );
  return {
    tokenHash: hash,
    phone: s.phone,
    riderId: await riderForPhone(pool, s.phone),
    startedAt: Number(s.started),
  };
}

/** Ends a session (the rider signs out, or staff end it, with why). Ending it twice is no error. */
export async function endRiderSession(
  pool: Pool,
  tokenHash: string,
  end: { readonly by: string; readonly why: string; readonly riderId: string | null },
  now: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO rider_session_ends (token_hash, rider_id, by, why, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT DO NOTHING`,
    [tokenHash, end.riderId, end.by.slice(0, 120), end.why.slice(0, 300), now],
  );
}
