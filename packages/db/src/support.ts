// P3.15: support. Brand and rider requests in one inbox. A message coming in (WhatsApp or email) joins
// the open conversation with that person, or starts one, matched to the rider (by phone) or brand (by
// its contact) it came from; staff can also start one for a call or a visit. Staff reply (WhatsApp or
// email, through the messages adapter: each reply sent once), add notes only staff see, pick a
// conversation up, and mark it waiting or done, with why. Nothing is edited or deleted.
import type { InboundMessage, MessagesAdapter } from '@recall/adapters';
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fillWording } from '@recall/domain';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { setting } from './settings.js';

type Q = Pick<PoolClient, 'query'>;

export type SupportChannel = 'whatsapp' | 'email' | 'phone' | 'in person';
export type SupportState = 'open' | 'waiting' | 'done';
export type PartyKind = 'rider' | 'brand';

const PHONE = /^\+91[6-9]\d{9}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);
/** How long the messages provider has to answer a reply. */
const REPLY_WAIT_MS = 30_000;
const newThreadId = () => `SUP-${randomBytes(5).toString('hex').toUpperCase()}`;

/** Text staff type: trimmed, within its length, no control characters (new lines allowed). */
function words(x: string, what: string, max: number, min = 1): string {
  const t = x.trim();
  if (t.length < min || t.length > max || CONTROL.test(t))
    throw new Refusal(`${what}: ${min} to ${max} letters`);
  return t;
}

/** The rider or brand a phone or email belongs to now (a rider first, by phone), or null. */
async function partyOf(c: Q, contact: string): Promise<{ kind: PartyKind; id: string } | null> {
  if (PHONE.test(contact)) {
    const r = await c.query<{ rider_id: string }>(
      `SELECT rider_id FROM (SELECT DISTINCT ON (rider_id) rider_id, phone FROM rider_versions
                              ORDER BY rider_id, version DESC) v
        WHERE v.phone = $1 ORDER BY rider_id DESC LIMIT 1`,
      [contact],
    );
    if (r.rows[0]) return { kind: 'rider', id: r.rows[0].rider_id };
  }
  const b = await c.query<{ brand_id: string }>(
    `SELECT brand_id FROM (SELECT DISTINCT ON (brand_id) brand_id, phone, email FROM brand_contacts
                            ORDER BY brand_id, set_at DESC) k
      WHERE k.phone = $1 OR lower(k.email) = lower($1) ORDER BY brand_id LIMIT 1`,
    [contact],
  );
  return b.rows[0] ? { kind: 'brand', id: b.rows[0].brand_id } : null;
}

const lockThreads = (c: PoolClient, contact: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`support:${contact}`]);

async function addMessage(
  c: Q,
  threadId: string,
  m: {
    direction: 'in' | 'out' | 'note';
    body: string;
    providerId?: string | null;
    status?: 'sending' | null;
    detail?: string | null;
    by: string;
    at: number;
  },
) {
  return c.query<{ seq: number }>(
    `INSERT INTO support_messages
       (thread_id, seq, direction, body, provider_id, status, detail, by_who, at)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, $6, $7, to_timestamp($8)
       FROM support_messages WHERE thread_id = $1
     RETURNING seq`,
    [
      threadId,
      m.direction,
      m.body,
      m.providerId ?? null,
      m.status ?? null,
      m.detail ?? null,
      m.by,
      m.at,
    ],
  );
}

async function addStep(
  c: Q,
  threadId: string,
  s: { state: SupportState; owner: string | null; reason: string; by: string; at: number },
) {
  await c.query(
    `INSERT INTO support_steps (thread_id, seq, state, owner, reason, by_who, at)
     SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5, to_timestamp($6)
       FROM support_steps WHERE thread_id = $1`,
    [threadId, s.state, s.owner, s.reason, s.by, s.at],
  );
}

/** A thread's latest step (state and owner). */
async function stepOf(c: Q, threadId: string) {
  const r = await c.query<{ state: SupportState; owner: string | null }>(
    'SELECT state, owner FROM support_steps WHERE thread_id = $1 ORDER BY seq DESC LIMIT 1',
    [threadId],
  );
  return r.rows[0] ?? null;
}

/**
 * A message coming in: kept once (by the provider's id), in the person's open conversation on that
 * channel, or a new one (a conversation marked done opens again when they write). Returns the
 * conversation, and whether this message was new.
 */
export async function receiveMessage(
  pool: Pool,
  m: InboundMessage,
  now: number,
): Promise<{ threadId: string; isNew: boolean }> {
  const contact = m.channel === 'email' ? m.from.toLowerCase() : m.from;
  return inTransaction(pool, async (c) => {
    await lockThreads(c, contact);
    const seen = await c.query<{ thread_id: string }>(
      `SELECT thread_id FROM support_messages WHERE provider_id = $1 AND direction = 'in'`,
      [`${m.channel}:${m.providerId}`],
    );
    if (seen.rows[0]) return { threadId: seen.rows[0].thread_id, isNew: false };
    const last = await c.query<{ thread_id: string }>(
      `SELECT thread_id FROM support_threads WHERE contact = $1 AND channel = $2
        ORDER BY created_at DESC LIMIT 1`,
      [contact, m.channel],
    );
    let threadId = last.rows[0]?.thread_id;
    // The same lock as staff notes, replies and steps on this conversation.
    if (threadId) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadId]);
    const text = (m.text.trim() || '(no text)').slice(0, 10_000);
    if (!threadId) {
      threadId = newThreadId();
      const party = await partyOf(c, contact);
      // One line, no control characters (it becomes an email subject in replies).
      const subject =
        (m.subject?.trim() || text.split(/\r?\n/)[0] || 'Message')
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]+/g, ' ')
          .trim()
          .slice(0, 200) || 'Message';
      await c.query(
        `INSERT INTO support_threads (thread_id, channel, contact, party_kind, party_id, subject,
           created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, 'inbound', to_timestamp($7))`,
        [threadId, m.channel, contact, party?.kind ?? null, party?.id ?? null, subject, now],
      );
      await addStep(c, threadId, {
        state: 'open',
        owner: null,
        reason: 'new message',
        by: 'inbound',
        at: now,
      });
    } else {
      const step = await stepOf(c, threadId);
      if (step?.state !== 'open')
        await addStep(c, threadId, {
          state: 'open',
          owner: step?.owner ?? null,
          reason: 'they wrote again',
          by: 'inbound',
          at: now,
        });
    }
    await addMessage(c, threadId, {
      direction: 'in',
      body: text,
      providerId: `${m.channel}:${m.providerId}`,
      by: contact,
      at: now,
    });
    return { threadId, isNew: true };
  });
}

/** Staff start a conversation (a call, a visit, or to write first), with what was said. */
export async function openThread(
  pool: Pool,
  t: {
    readonly channel: SupportChannel;
    readonly contact: string;
    readonly subject: string;
    readonly note: string;
  },
  by: { readonly id: string; readonly name: string },
  now: number,
): Promise<string> {
  const contact = t.contact.includes('@') ? t.contact.trim().toLowerCase() : t.contact.trim();
  if (!PHONE.test(contact) && !EMAIL.test(contact))
    throw new Refusal('Who: a mobile number (+91 and 10 digits) or an email address');
  if (t.channel === 'whatsapp' && !PHONE.test(contact))
    throw new Refusal('WhatsApp needs a mobile number');
  if (t.channel === 'email' && !EMAIL.test(contact))
    throw new Refusal('Email needs an email address');
  const subject = words(t.subject, 'What it is about', 200, 3);
  const note = words(t.note, 'What was said', 5000, 3);
  return inTransaction(pool, async (c) => {
    await lockThreads(c, contact);
    const threadId = newThreadId();
    const party = await partyOf(c, contact);
    await c.query(
      `INSERT INTO support_threads (thread_id, channel, contact, party_kind, party_id, subject,
         created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
      [threadId, t.channel, contact, party?.kind ?? null, party?.id ?? null, subject, by.id, now],
    );
    await addStep(c, threadId, {
      state: 'open',
      owner: by.id,
      reason: 'started by staff',
      by: by.id,
      at: now,
    });
    await addMessage(c, threadId, { direction: 'note', body: note, by: by.id, at: now });
    return threadId;
  });
}

/** A note only staff see. */
export async function noteThread(
  pool: Pool,
  threadId: string,
  text: string,
  by: { readonly id: string },
  now: number,
): Promise<void> {
  const body = words(text, 'The note', 5000);
  await inTransaction(pool, async (c) => {
    const t = await c.query('SELECT 1 FROM support_threads WHERE thread_id = $1', [threadId]);
    if (t.rows.length === 0) throw new Refusal(`No conversation ${threadId}`);
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadId]);
    await addMessage(c, threadId, { direction: 'note', body, by: by.id, at: now });
  });
}

/**
 * Replies on the conversation's channel (WhatsApp or email) to the person. Each reply is its own
 * message, sent once (its key is the conversation and the reply's number); a failed one is shown
 * and can be written again. A call or visit has no channel to reply on: a note is kept instead.
 */
export async function replyThread(
  pool: Pool,
  messages: MessagesAdapter,
  threadId: string,
  text: string,
  by: { readonly id: string; readonly name: string },
  now: number,
): Promise<'sent' | 'failed' | 'unconfirmed'> {
  const body = words(text, 'The reply', 4000);
  const t = await pool.query<{ channel: SupportChannel; contact: string; subject: string }>(
    'SELECT channel, contact, subject FROM support_threads WHERE thread_id = $1',
    [threadId],
  );
  const thread = t.rows[0];
  if (!thread) throw new Refusal(`No conversation ${threadId}`);
  if (thread.channel !== 'whatsapp' && thread.channel !== 'email')
    throw new Refusal(
      'This conversation was a call or a visit: add a note, or start one on WhatsApp',
    );
  // The wording is a setting (P3.17), read before the reply is written down.
  const wording = (await setting(pool, 'messages')).supportReply;
  const values = { reply: body, subject: thread.subject };
  // The reply is written down first, under the conversation's lock: its number is its key, so two
  // replies never share one, and a reply sent but never confirmed is still there to see.
  const seq = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadId]);
    const r = await addMessage(c, threadId, {
      direction: 'out',
      body,
      status: 'sending',
      detail: by.name,
      by: by.id,
      at: now,
    });
    return r.rows[0]?.seq ?? 0;
  });
  const key = `support:${threadId}:${seq}`;
  let timer: NodeJS.Timeout | undefined;
  const sending = messages
    .send(
      thread.channel === 'whatsapp'
        ? {
            channel: 'whatsapp',
            key,
            to: thread.contact,
            template: wording.whatsappTemplate,
            params: [body],
          }
        : {
            channel: 'email',
            key,
            to: thread.contact,
            subject: fillWording(wording.emailSubject, values)
              .replace(/[\r\n]+/g, ' ')
              .slice(0, 200),
            text: fillWording(wording.emailText, values),
            html: fillWording(wording.emailText, values)
              .replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
              .split(/\n{2,}/)
              .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
              .join(''),
            attachments: [],
          },
    )
    .catch(
      (e: unknown) =>
        ({
          status: 'failed',
          reason: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          retryable: true,
        }) as const,
    );
  // No answer within 30 seconds: it may or may not have gone, so no result is written (the reply
  // shows as not confirmed), never "failed" (writing it again could send it twice).
  const result = await Promise.race([
    sending,
    new Promise<'timeout'>((ok) => {
      timer = setTimeout(() => ok('timeout'), REPLY_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (result === 'timeout') return 'unconfirmed';
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO support_reply_results (thread_id, seq, status, provider_id, detail, at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
      [
        threadId,
        seq,
        result.status,
        result.status === 'sent' ? result.providerRef.slice(0, 200) : null,
        result.status === 'failed' ? result.reason.slice(0, 300) : null,
        now,
      ],
    ),
  );
  return result.status;
}

/** Picks a conversation up (`owner`: a staff id, or null to put it back), or marks it waiting or done. */
export async function stepThread(
  pool: Pool,
  threadId: string,
  step: { readonly state: SupportState; readonly owner: string | null; readonly reason: string },
  by: { readonly id: string },
  now: number,
): Promise<void> {
  const reason = words(step.reason, 'Say why', 300, 3);
  await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [threadId]);
    const before = await stepOf(c, threadId);
    if (!before) throw new Refusal(`No conversation ${threadId}`);
    if (before.state === step.state && before.owner === step.owner)
      throw new Refusal('Nothing changes');
    await addStep(c, threadId, { ...step, reason, by: by.id, at: now });
  });
}

export interface ThreadRow {
  readonly threadId: string;
  readonly channel: SupportChannel;
  readonly contact: string;
  readonly party: { kind: PartyKind; id: string; name: string } | null;
  readonly subject: string;
  readonly state: SupportState;
  /** Who has it: their name, and their staff id. */
  readonly owner: string | null;
  readonly ownerId: string | null;
  readonly createdAt: number;
  readonly lastAt: number;
  readonly lastText: string;
  /** Since when the person has been waiting for us (their last message after our last reply). */
  readonly waitingSince: number | null;
}

const ROW_SQL = `
  SELECT t.thread_id, t.channel, t.contact, t.party_kind, t.party_id, t.subject, t.created_at,
         s.state, s.owner,
         (SELECT name FROM staff WHERE id = s.owner) AS owner_name,
         CASE t.party_kind
           WHEN 'rider' THEN (SELECT v.name FROM rider_versions v WHERE v.rider_id = t.party_id
                               ORDER BY v.version DESC LIMIT 1)
           WHEN 'brand' THEN (SELECT v.name FROM brand_versions v WHERE v.brand_id = t.party_id
                               ORDER BY v.version DESC LIMIT 1)
         END AS party_name,
         m.at AS last_at, m.body AS last_text,
         (SELECT min(i.at) FROM support_messages i WHERE i.thread_id = t.thread_id
            AND i.direction = 'in'
            AND i.seq > coalesce((SELECT max(o.seq) FROM support_reply_results o
                                   WHERE o.thread_id = t.thread_id AND o.status = 'sent'), 0))
           AS waiting_since
    FROM support_threads t
    JOIN LATERAL (SELECT state, owner FROM support_steps x WHERE x.thread_id = t.thread_id
                   ORDER BY seq DESC LIMIT 1) s ON true
    JOIN LATERAL (SELECT at, body FROM support_messages y WHERE y.thread_id = t.thread_id
                   ORDER BY seq DESC LIMIT 1) m ON true`;

type RowShape = {
  thread_id: string;
  channel: SupportChannel;
  contact: string;
  party_kind: PartyKind | null;
  party_id: string | null;
  party_name: string | null;
  subject: string;
  created_at: Date;
  state: SupportState;
  owner: string | null;
  owner_name: string | null;
  last_at: Date;
  last_text: string;
  waiting_since: Date | null;
};

const toRow = (x: RowShape): ThreadRow => ({
  threadId: x.thread_id,
  channel: x.channel,
  contact: x.contact,
  party:
    x.party_kind && x.party_id
      ? { kind: x.party_kind, id: x.party_id, name: x.party_name ?? x.party_id }
      : null,
  subject: x.subject,
  state: x.state,
  owner: x.owner_name ?? x.owner,
  ownerId: x.owner,
  createdAt: secs(x.created_at),
  lastAt: secs(x.last_at),
  lastText: x.last_text.slice(0, 200),
  waitingSince: x.waiting_since ? secs(x.waiting_since) : null,
});

/**
 * The inbox: conversations in a state (default: not done), longest waiting first, then newest
 * (at most 200). `party` narrows it to one rider's or brand's.
 */
export async function supportInbox(
  c: Q,
  filter: {
    readonly state?: SupportState | 'all';
    readonly party?: { kind: PartyKind; id: string };
  } = {},
): Promise<ThreadRow[]> {
  const r = await c.query<RowShape>(
    `SELECT * FROM (${ROW_SQL}) x
      WHERE ($1::text = 'all' OR ($1::text = 'active' AND x.state <> 'done') OR x.state = $1)
        AND ($2::text IS NULL OR (x.party_kind = $2 AND x.party_id = $3))
      ORDER BY x.waiting_since ASC NULLS LAST, x.last_at DESC LIMIT 200`,
    [filter.state ?? 'active', filter.party?.kind ?? null, filter.party?.id ?? null],
  );
  return r.rows.map(toRow);
}

export interface ThreadPage extends ThreadRow {
  /** Every message in and out and every note, and every step, oldest first. */
  readonly timeline: readonly {
    at: number;
    kind: 'in' | 'out' | 'note' | 'step';
    by: string;
    text: string;
    status: 'sending' | 'sent' | 'failed' | null;
  }[];
}

/** One conversation with its whole history, or null. */
export async function supportThread(c: Q, threadId: string): Promise<ThreadPage | null> {
  const r = await c.query<RowShape>(`SELECT * FROM (${ROW_SQL}) x WHERE x.thread_id = $1`, [
    threadId,
  ]);
  const row = r.rows[0];
  if (!row) return null;
  const [msgs, steps] = await Promise.all([
    c.query<{
      direction: 'in' | 'out' | 'note';
      body: string;
      result: 'sent' | 'failed' | null;
      why: string | null;
      by_who: string;
      by_name: string | null;
      at: Date;
      n: string;
    }>(
      `SELECT m.direction, m.body, x.status AS result, x.detail AS why, m.by_who, m.at, m.n,
              (SELECT name FROM staff WHERE id = m.by_who) AS by_name
         FROM support_messages m
         LEFT JOIN support_reply_results x USING (thread_id, seq)
        WHERE m.thread_id = $1 ORDER BY m.seq`,
      [threadId],
    ),
    c.query<{
      state: SupportState;
      owner: string | null;
      owner_name: string | null;
      reason: string;
      by_who: string;
      by_name: string | null;
      at: Date;
      n: string;
    }>(
      `SELECT state, owner, reason, by_who, at, n,
              (SELECT name FROM staff WHERE id = owner) AS owner_name,
              (SELECT name FROM staff WHERE id = by_who) AS by_name
         FROM support_steps WHERE thread_id = $1 ORDER BY seq`,
      [threadId],
    ),
  ]);
  const timeline = [
    ...msgs.rows.map((m) => ({
      at: secs(m.at),
      order: Number(m.n),
      kind: m.direction,
      by: m.direction === 'in' ? row.contact : (m.by_name ?? m.by_who),
      text:
        m.direction !== 'out' || m.result === 'sent'
          ? m.body
          : m.result === 'failed'
            ? `${m.body} (not sent: ${m.why ?? ''})`
            : `${m.body} (not confirmed: it may or may not have gone; ask them)`,
      status: m.direction === 'out' ? (m.result ?? ('sending' as const)) : null,
    })),
    ...steps.rows.map((s) => ({
      at: secs(s.at),
      order: Number(s.n),
      kind: 'step' as const,
      by: s.by_name ?? s.by_who,
      text: `${s.state}${s.owner ? ` · with ${s.owner_name ?? s.owner}` : ''}: ${s.reason}`,
      status: null,
    })),
  ]
    // In the order it happened (one running number for messages and steps).
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ at: e.at, kind: e.kind, by: e.by, text: e.text, status: e.status }));
  return { ...toRow(row), timeline };
}

/**
 * P4.8: a rider writes from the rider app (a screen problem, a question): a new conversation with
 * him, on WhatsApp (replies go to his phone), inside the caller's transaction. Returns its id.
 */
export async function threadFromRiderApp(
  c: PoolClient,
  r: {
    readonly riderId: string;
    readonly phone: string;
    readonly subject: string;
    readonly text: string;
    readonly at: number;
  },
): Promise<string> {
  if (!PHONE.test(r.phone)) throw new Refusal('His mobile number is not a mobile number');
  await lockThreads(c, r.phone);
  const threadId = newThreadId();
  await c.query(
    `INSERT INTO support_threads (thread_id, channel, contact, party_kind, party_id, subject,
       created_by, created_at) VALUES ($1, 'whatsapp', $2, 'rider', $3, $4, 'rider app', to_timestamp($5))`,
    [threadId, r.phone, r.riderId, words(r.subject, 'What it is about', 200), r.at],
  );
  await addStep(c, threadId, {
    state: 'open',
    owner: null,
    reason: 'sent from the rider app',
    by: 'rider app',
    at: r.at,
  });
  await addMessage(c, threadId, {
    direction: 'in',
    body: words(r.text, 'What happened', 10_000),
    by: r.phone,
    at: r.at,
  });
  return threadId;
}
