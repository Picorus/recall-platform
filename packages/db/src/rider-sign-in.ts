// P4.1: rider sign-in in the database. A code is asked for (few per number and connection, per day,
// per connection, and for everyone together), sent on WhatsApp or by SMS, kept only as a keyed
// fingerprint, and works for a few minutes and a few tries; only the newest code that was sent
// counts. A right code opens a session for the rider the number belongs to at that moment (its
// token is kept only as a fingerprint); the session lasts until the rider signs out, staff end it,
// the rider's number changes, or it goes unused for the idle days.
import type { MessageResult, MessagesAdapter } from '@recall/adapters';
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

/** How long the provider has to take a code (then it counts as not sent; the rider asks again). */
const SEND_WAIT_MS = 10_000;

const fingerprint = (secret: Buffer, phone: string, code: string) =>
  createHmac('sha256', secret).update(`rider-code\n${phone}\n${code}`).digest('hex');
export const riderTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** The connection's lock, then the number's: always in this order, so two never wait on each other. */
async function lock(c: Q, ip: string, phone: string) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider-sign-in-ip:${ip}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider-sign-in:${phone}`]);
}

/** The start of the India day `now` falls in (UTC seconds). */
const indiaDayStart = (now: number) => {
  const shift = 330 * 60;
  return Math.floor((now + shift) / 86_400) * 86_400 - shift;
};

const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

type Refused = { readonly refused: string; readonly why: { code: string; n?: number } };

/**
 * Sends a sign-in code to a number. Refused (in words the rider can act on) when too many have been
 * asked for. Returns when the code stops working.
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
  const made = await inTransaction(pool, async (c): Promise<Refused | { codeId: string }> => {
    await lock(c, ask.ip, ask.phone);
    const all = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM rider_codes WHERE sent_at > to_timestamp($1) - interval '1 hour'`,
      [now],
    );
    if (Number(all.rows[0]?.n ?? 0) >= rules.codesPerHourAll)
      return { refused: 'Sign-in is busy: try again in a few minutes', why: { code: 'busy' } };
    const r = await c.query<{ recent: string; today: string; first: string | null }>(
      `SELECT count(*) FILTER (WHERE ip = $4 AND sent_at > to_timestamp($2) - interval '15 minutes') AS recent,
              count(*) FILTER (WHERE sent_at >= to_timestamp($3)) AS today,
              extract(epoch FROM min(sent_at) FILTER
                (WHERE ip = $4 AND sent_at > to_timestamp($2) - interval '15 minutes'))::bigint AS first
         FROM rider_codes
        WHERE phone = $1 AND sent_at >= least(to_timestamp($3), to_timestamp($2) - interval '15 minutes')`,
      [ask.phone, now, indiaDayStart(now), ask.ip],
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
  if ('refused' in made) throw new Refusal(made.refused, made.why);
  // Sent after the code is written down: its own key, so a retry never sends a second message.
  const key = `rider-code:${made.codeId}`;
  let timer: NodeJS.Timeout | undefined;
  const failed = (reason: string): MessageResult => ({ status: 'failed', reason, retryable: true });
  const result = await Promise.race([
    messages
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
      .catch((e: unknown) => failed(`no answer: ${e instanceof Error ? e.message : String(e)}`)),
    new Promise<MessageResult>((ok) => {
      timer = setTimeout(() => ok(failed('no answer in 10 s')), SEND_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
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

/**
 * The rider whose details now carry this number: one still with RECALL first (not left or turned
 * down), then the newest.
 */
export async function riderForPhone(c: Q, phone: string): Promise<string | null> {
  const r = await c.query<{ rider_id: string }>(
    `SELECT r.rider_id FROM riders r
       JOIN LATERAL (SELECT phone FROM rider_versions x WHERE x.rider_id = r.rider_id
                      ORDER BY version DESC LIMIT 1) v ON true
       LEFT JOIN LATERAL (SELECT status FROM rider_steps t WHERE t.rider_id = r.rider_id
                           ORDER BY seq DESC LIMIT 1) st ON true
      WHERE v.phone = $1
      ORDER BY (coalesce(st.status, '') IN ('left', 'rejected')), r.created_at DESC, r.rider_id DESC
      LIMIT 1`,
    [phone],
  );
  return r.rows[0]?.rider_id ?? null;
}

/**
 * Checks a code typed for a number. Right: a new session (its token, given only now) for the rider
 * the number belongs to now (none: a new rider, who signs up next). Wrong: refused, saying how many
 * tries are left. Every try is kept, right or wrong.
 */
export async function checkRiderCode(
  pool: Pool,
  typed: { readonly phone: string; readonly code: string; readonly ip: string },
  secret: Buffer,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<{ readonly token: string; readonly riderId: string | null }> {
  const out = await inTransaction(
    pool,
    async (c): Promise<Refused | { token: string; riderId: string | null }> => {
      await lock(c, typed.ip, typed.phone);
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
      const wrongToday = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM rider_code_tries
          WHERE phone = $1 AND NOT ok AND at >= to_timestamp($2)`,
        [typed.phone, indiaDayStart(now)],
      );
      if (Number(wrongToday.rows[0]?.n ?? 0) >= rules.wrongPerNumberDay)
        return {
          refused: 'Too many wrong codes for this number today: try again tomorrow',
          why: { code: 'too-many-wrong-number' },
        };
      // Only the newest code that was sent counts (one that failed to go never replaces one that
      // did), while it lasts, is unused and has tries left.
      const live = await c.query<{ code_id: string; code_hash: string; wrong: string }>(
        `SELECT k.code_id, k.code_hash,
                (SELECT count(*) FROM rider_code_tries t WHERE t.code_id = k.code_id AND NOT t.ok) AS wrong
           FROM rider_codes k
          WHERE k.phone = $1 AND k.sent_at <= to_timestamp($2) AND k.expires_at > to_timestamp($2)
            AND k.code_id = (SELECT max(x.code_id) FROM rider_codes x
                              WHERE x.phone = $1
                                AND NOT EXISTS (SELECT 1 FROM rider_code_sends f
                                                 WHERE f.code_id = x.code_id AND f.status = 'failed'))
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
      const riderId = await riderForPhone(c, typed.phone);
      await c.query(
        `INSERT INTO rider_sessions (token_hash, phone, rider_id, code_id, ip, started_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
        [riderTokenHash(token), typed.phone, riderId, code.code_id, typed.ip, now],
      );
      return { token, riderId };
    },
  );
  // A wrong try is kept (the transaction above is done) before the rider is told.
  if ('refused' in out) throw new Refusal(out.refused, out.why);
  return out;
}

export interface RiderSession {
  readonly tokenHash: string;
  readonly phone: string;
  /** Null: a new number, not yet signed up. */
  readonly riderId: string | null;
  readonly startedAt: number;
}

/**
 * The session behind a token, if it is still open: not ended, not idle too long, and its rider
 * still has the number it was opened with (a number changed or given to someone else ends it).
 */
export async function riderSession(
  pool: Pool,
  token: string,
  now: number,
  rules: RiderSignInRules = DEFAULT_RIDER_SIGN_IN,
): Promise<RiderSession | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const hash = riderTokenHash(token);
  const r = await pool.query<{
    phone: string;
    rider_id: string | null;
    rider_phone: string | null;
    started: string;
    last: string;
  }>(
    `SELECT s.phone, coalesce(s.rider_id, j.rider_id) AS rider_id,
            (SELECT phone FROM rider_versions v WHERE v.rider_id = coalesce(s.rider_id, j.rider_id)
              ORDER BY version DESC LIMIT 1) AS rider_phone,
            extract(epoch FROM s.started_at)::bigint AS started,
            extract(epoch FROM greatest(s.started_at,
              (SELECT max(at) FROM rider_session_seen w WHERE w.token_hash = s.token_hash)))::bigint AS last
       FROM rider_sessions s LEFT JOIN rider_session_joins j USING (token_hash)
      WHERE s.token_hash = $1
        AND NOT EXISTS (SELECT 1 FROM rider_session_ends e WHERE e.token_hash = s.token_hash)`,
    [hash],
  );
  const s = r.rows[0];
  if (!s || now - Number(s.last) > rules.idleDays * 86_400) return undefined;
  if (s.rider_id !== null && s.rider_phone !== s.phone) return undefined;
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
    riderId: s.rider_id,
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
