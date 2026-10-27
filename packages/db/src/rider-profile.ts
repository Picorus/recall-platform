// P4.11 in the database: the rider app's profile. His details, his papers and where each stands
// (with the insurance's end date), where he is paid (masked), and his requests: to change that
// account (a super admin does it with him on a call: a phone in the wrong hands never moves his
// pay), to leave RECALL, or to delete his account. Each request opens a support conversation.
import { showMobile } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { joinPage, type JoinPage } from './rider-app.js';
import { payoutAccountOf } from './rider-checks.js';
import { threadFromRiderApp } from './support.js';

type Q = Pick<Pool, 'query'>;

export const RIDER_REQUEST_KINDS = ['bank-change', 'leave', 'delete'] as const;
export type RiderRequestKind = (typeof RIDER_REQUEST_KINDS)[number];

/** For staff: the conversation's subject and first message. */
const REQUEST_WORDS: Record<RiderRequestKind, { subject: string; text: string }> = {
  'bank-change': {
    subject: 'Rider app: wants to change the bank he is paid to',
    text: 'He asked on the rider app to change his bank account or UPI. Call him; a super admin checks the new account (₹1) on his rider page. No account details are taken in the app.',
  },
  leave: {
    subject: 'Rider app: wants to leave RECALL',
    text: 'He asked on the rider app to leave RECALL. Call him: take the screen back, settle his last pay and tell the bank about his screen loan (the leaving list on his rider page).',
  },
  delete: {
    subject: 'URGENT: account deletion request',
    text: 'He asked on the rider app to delete his account (DPDP). Settle the screen, pay and loan first; then erase or blank his personal details, keeping only what the law requires (open question 18).',
  },
};

export interface RiderProfile {
  readonly riderId: string;
  readonly name: string;
  readonly shown: string;
  readonly bikePlate: string | null;
  readonly status: string;
  readonly documents: JoinPage['documents'];
  /** Where he is paid, masked; null when no account has passed its check. */
  readonly account: string | null;
  /** His requests still being worked on (by kind). */
  readonly open: readonly RiderRequestKind[];
}

/** His requests whose conversation is not done yet. */
async function openRequests(c: Q, riderId: string): Promise<RiderRequestKind[]> {
  const r = await c.query<{ kind: RiderRequestKind }>(
    `SELECT DISTINCT q.kind FROM rider_requests q
      WHERE q.rider_id = $1
        AND coalesce((SELECT state FROM support_steps s WHERE s.thread_id = q.thread_id
                       ORDER BY seq DESC LIMIT 1), 'open') <> 'done'
      ORDER BY q.kind`,
    [riderId],
  );
  return r.rows.map((x) => x.kind);
}

export async function riderProfile(pool: Q, riderId: string, now: number): Promise<RiderProfile> {
  const page = await joinPage(pool as Pool, riderId, now);
  const [account, open] = await Promise.all([
    payoutAccountOf(pool, riderId),
    openRequests(pool, riderId),
  ]);
  return {
    riderId,
    name: page.details.name,
    shown: showMobile(page.details.phone),
    bikePlate: page.details.bikePlate,
    status: page.status,
    documents: page.documents,
    account: account?.shown ?? null,
    open,
  };
}

/**
 * He asks (to change his bank, to leave, to delete his account): a support conversation with him
 * and the request, once while one of that kind is open. Returns whether it is new.
 */
export async function riderRequest(
  pool: Pool,
  r: { readonly riderId: string; readonly phone: string; readonly kind: string },
  now: number,
): Promise<{ readonly isNew: boolean }> {
  if (!(RIDER_REQUEST_KINDS as readonly string[]).includes(r.kind))
    throw new Refusal('What do you want to do?', { code: 'bad-kind' });
  const kind = r.kind as RiderRequestKind;
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`requests:${r.riderId}`]);
    if ((await openRequests(c, r.riderId)).includes(kind)) return { isNew: false };
    const w = REQUEST_WORDS[kind];
    const threadId = await threadFromRiderApp(c, {
      riderId: r.riderId,
      phone: r.phone,
      subject: w.subject,
      text: w.text,
      at: now,
    });
    await c.query(
      `INSERT INTO rider_requests (request_id, rider_id, kind, thread_id, at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [`REQ-${randomBytes(5).toString('hex').toUpperCase()}`, r.riderId, kind, threadId, now],
    );
    return { isNew: true };
  });
}
