// P3.13.2: paying money owed back to brands. Each amount owed back is the ledger entry that put it on
// the books (an approved refund with its credit note, or a payment after a cancellation or of a
// wrong amount). Finance sends it back through the payment provider against the brand's payment
// (the same key every try, so it is never sent twice), or, when that cannot work, records a bank
// transfer made by hand. Either way the money leaves the books once, with who, when and how.
import { createHash } from 'node:crypto';
import { moneyPaidBack } from '@recall/domain';
import type { PaymentsAdapter, RefundResult } from '@recall/adapters';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { Refusal } from './refusal.js';

type Q = Pick<PoolClient, 'query'>;

/** Tries through the provider before it is given up (then it is paid by hand). */
export const MAX_MONEY_BACK_TRIES = 3;
/** How long the provider has to answer before it counts as no answer (asked again later). */
const PROVIDER_WAIT_MS = 30_000;
/** Written, and committed, before the provider is asked: an answer lost after it was sent never
 * leaves the item looking unsent (so it is never also paid by hand). */
const ASKED = 'asked the provider';

export type MoneyBackState = 'owed' | 'pending' | 'failed' | 'given up' | 'refunded' | 'by-hand';

export interface MoneyBackItem {
  /** The ledger entry that put it on the books: its id everywhere. */
  readonly owedEntry: string;
  readonly kind: 'refund' | 'payment back';
  readonly bookingId: string | null;
  readonly brandId: string | null;
  readonly brandName: string;
  readonly amountPaise: number;
  readonly owedAt: number;
  readonly why: string;
  /** The payment it goes back against, if one is known. */
  readonly paymentId: string | null;
  readonly state: MoneyBackState;
  readonly reason: string | null;
  readonly tries: number;
  readonly history: readonly { at: number; by: string; text: string }[];
}

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
const DONE: readonly MoneyBackState[] = ['refunded', 'by-hand'];

async function nameOf(c: Q, id: string): Promise<string> {
  const r = await c.query<{ name: string }>('SELECT name FROM staff WHERE id = $1', [id]);
  return r.rows[0]?.name ?? id;
}

/** Every amount owed back (or one), oldest first, with where it stands. */
async function items(c: Q, only: string | null, open: boolean): Promise<MoneyBackItem[]> {
  const r = await c.query<{
    entry_id: string;
    kind: string;
    ref: string;
    memo: string;
    at: Date;
    party: string | null;
    brand_name: string | null;
    amount: string;
    booking_payment: string | null;
  }>(
    `SELECT e.entry_id, e.kind, e.ref, e.memo, e.at, p.party,
            (SELECT v.name FROM brand_versions v WHERE v.brand_id = p.party
              ORDER BY v.version DESC LIMIT 1) AS brand_name,
            p.credit - p.debit AS amount,
            (SELECT x.payment_id FROM payment_link_events x JOIN payment_links l USING (link_id)
              WHERE l.booking_id = split_part(e.ref, '/', 1) AND x.state = 'paid'
              ORDER BY x.id LIMIT 1) AS booking_payment
       FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
      WHERE p.account = 'refunds-payable' AND p.credit > 0
        AND e.kind IN ('refund-approved', 'money-to-return')
        AND ($1::text IS NULL OR e.entry_id = $1)
        AND (NOT $2 OR NOT EXISTS (SELECT 1 FROM ledger_entries d
                                    WHERE d.entry_id = 'paid-back:' || e.entry_id))
      ORDER BY e.at, e.entry_id LIMIT 500`,
    [only, open],
  );
  if (r.rows.length === 0) return [];
  const tries = await c.query<{
    owed_entry: string;
    status: MoneyBackState;
    payment_id: string | null;
    provider_ref: string | null;
    reason: string | null;
    by_who: string;
    by_name: string | null;
    at: Date;
  }>(
    `SELECT a.owed_entry, a.status, a.payment_id, a.provider_ref, a.reason, a.by_who,
            (SELECT name FROM staff WHERE id = a.by_who) AS by_name, a.at
       FROM money_back_attempts a WHERE a.owed_entry = ANY($1) ORDER BY a.owed_entry, a.attempt`,
    [r.rows.map((x) => x.entry_id)],
  );
  return r.rows.map((x) => {
    const mine = tries.rows.filter((t) => t.owed_entry === x.entry_id);
    const last = mine.at(-1);
    const isRefund = x.kind === 'refund-approved';
    const bookingId = /^BK-/.test(x.ref) ? (x.ref.split('/')[0] ?? null) : null;
    return {
      owedEntry: x.entry_id,
      kind: isRefund ? 'refund' : 'payment back',
      bookingId,
      brandId: x.party,
      brandName: x.brand_name ?? x.party ?? 'not known',
      amountPaise: Number(x.amount),
      owedAt: secs(x.at),
      why: x.memo,
      paymentId: isRefund ? x.booking_payment : x.entry_id.replace(/^to-return:/, ''),
      state: last?.status ?? 'owed',
      reason:
        last?.status === 'by-hand'
          ? `bank transfer ${last.provider_ref ?? ''}`
          : (last?.reason ?? null),
      tries: mine.filter((t) => t.reason === ASKED).length,
      history: mine.map((t) => ({
        at: secs(t.at),
        by: t.by_name ?? t.by_who,
        text:
          t.status === 'by-hand'
            ? `sent by bank transfer (${t.provider_ref ?? ''})${t.reason ? `: ${t.reason}` : ''}`
            : `${t.status}${t.reason ? `: ${t.reason}` : ''}`,
      })),
    };
  });
}

/** What is still owed back (not yet sent back), oldest first. */
export const moneyOwedBack = (c: Q) => items(c, null, true);

/** One amount owed back (or paid back), or null. */
export async function moneyBackItem(c: Q, owedEntry: string): Promise<MoneyBackItem | null> {
  return (await items(c, owedEntry, false))[0] ?? null;
}

const mayPay = (by: { readonly role: string }) => {
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new Refusal('Only finance or a super admin sends money back');
};

/**
 * One sender at a time for each amount owed back (held across the provider call); `work` gets the
 * held connection. A connection that broke is not given back to the pool.
 */
async function oneAtATime<T>(
  pool: Pool,
  owedEntry: string,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  const lock = `money-back:${owedEntry}`;
  let broken: Error | undefined;
  try {
    const got = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [
      lock,
    ]);
    if (!got.rows[0]?.ok) throw new Refusal('This is being sent back just now: try again');
    try {
      return await work(c);
    } finally {
      await c.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]).catch((e: unknown) => {
        broken = e instanceof Error ? e : new Error(String(e));
      });
    }
  } finally {
    c.release(broken);
  }
}

/** The provider's key for one try: the same until a try fails for sure (then a new one, since a
 * provider may replay a failure under its key), short enough for any provider. */
const refundKey = (owedEntry: string, failures: number) =>
  `mb_${createHash('sha256').update(`${owedEntry}#${failures}`).digest('hex').slice(0, 32)}`;

/** The provider's answer, or no answer (pending) if it throws or takes too long. */
async function ask(provider: PaymentsAdapter, req: Parameters<PaymentsAdapter['refund']>[0]) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.refund(req),
      new Promise<never>((_, no) => {
        timer = setTimeout(() => no(new Error('took too long')), PROVIDER_WAIT_MS);
      }),
    ]);
  } catch (e) {
    // It may have gone through, so it waits: asked again with the same key.
    const result: RefundResult = {
      status: 'pending',
      providerRef: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
    };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function inTx<T>(c: PoolClient, work: () => Promise<T>): Promise<T> {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE recall_app');
    const out = await work();
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

async function record(
  c: Q,
  owedEntry: string,
  a: {
    status: MoneyBackState;
    paymentId: string | null;
    ref: string | null;
    reason: string | null;
    by: string;
    at: number;
  },
) {
  await c.query(
    `INSERT INTO money_back_attempts
       (owed_entry, attempt, status, payment_id, provider_ref, reason, by_who, at)
     SELECT $1, coalesce(max(attempt), 0) + 1, $2, $3, $4, $5, $6, to_timestamp($7)
       FROM money_back_attempts WHERE owed_entry = $1`,
    [owedEntry, a.status, a.paymentId, a.ref, a.reason?.slice(0, 300) ?? null, a.by, a.at],
  );
}

/**
 * Sends an amount owed back through the payment provider, against the payment it came from (safe
 * to press again: the provider gets the same key, so a pending or lost answer is only asked again).
 * A failure that will not pass, or the third failure, gives it up: then it is paid by hand.
 */
export async function sendMoneyBack(
  pool: Pool,
  owedEntry: string,
  provider: PaymentsAdapter,
  by: { readonly id: string; readonly role: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<MoneyBackState> {
  mayPay(by);
  return oneAtATime(pool, owedEntry, async (c) => {
    const item = await moneyBackItem(c, owedEntry);
    if (!item) throw new Refusal(`Nothing owed back as ${owedEntry}`);
    if (DONE.includes(item.state)) throw new Refusal(`This was already sent back (${item.state})`);
    if (item.state === 'given up')
      throw new Refusal('The provider could not send this back: pay it by bank transfer');
    if (!item.paymentId)
      throw new Refusal('No payment to send it back against: pay it by bank transfer');
    const paymentId = item.paymentId;
    const base = { paymentId, by: by.id, at: now };
    const failuresBefore = item.history.filter((h) => h.text.startsWith('failed')).length;
    // First on the books (committed): the provider is being asked.
    await inTx(c, () =>
      record(c, owedEntry, { ...base, status: 'pending', ref: null, reason: ASKED }),
    );
    const result = await ask(provider, {
      refundKey: refundKey(owedEntry, failuresBefore),
      paymentId,
      amountPaise: item.amountPaise,
      note: `${item.kind} ${item.bookingId ?? ''}`.trim(),
    });
    return inTx(c, async () => {
      if (result.status === 'refunded') {
        await record(c, owedEntry, {
          ...base,
          status: 'refunded',
          ref: result.providerRef,
          reason: null,
        });
        await postEntry(
          c,
          moneyPaidBack({
            owedEntry,
            ref: item.bookingId ?? owedEntry,
            ...(item.brandId ? { brandId: item.brandId } : {}),
            amount: item.amountPaise,
            via: 'provider',
            note: `Sent back against ${item.paymentId} (${result.providerRef})`,
            at: now,
          }),
          by.id,
        );
        return 'refunded';
      }
      if (result.status === 'pending') {
        await record(c, owedEntry, {
          ...base,
          status: 'pending',
          ref: result.providerRef,
          reason: null,
        });
        return 'pending';
      }
      await record(c, owedEntry, { ...base, status: 'failed', ref: null, reason: result.reason });
      const failures = failuresBefore + 1;
      if (!result.retryable || failures >= MAX_MONEY_BACK_TRIES) {
        await record(c, owedEntry, {
          ...base,
          status: 'given up',
          ref: null,
          reason: result.reason,
        });
        return 'given up';
      }
      return 'failed';
    });
  });
}

/**
 * Records an amount owed back as paid by a bank transfer finance made by hand (its bank reference).
 * Not while the provider may still be sending it (pending): ask it again first. If the provider
 * never answers, only a super admin may record it, after checking with the provider that nothing
 * was sent (said in the note).
 */
export async function recordMoneyBackByHand(
  pool: Pool,
  owedEntry: string,
  transfer: { readonly reference: string; readonly note: string },
  by: { readonly id: string; readonly role: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  mayPay(by);
  const reference = transfer.reference.trim();
  if (!/^[A-Za-z0-9/ _-]{4,60}$/.test(reference))
    throw new Refusal('The bank reference (UTR): 4 to 60 letters and digits');
  const note = transfer.note.trim();
  // eslint-disable-next-line no-control-regex
  if (note.length > 300 || /[\u0000-\u001f\u007f]/.test(note))
    throw new Refusal('The note: up to 300 letters');
  await oneAtATime(pool, owedEntry, async (c) => {
    const item = await moneyBackItem(c, owedEntry);
    if (!item) throw new Refusal(`Nothing owed back as ${owedEntry}`);
    if (DONE.includes(item.state)) throw new Refusal(`This was already sent back (${item.state})`);
    if (item.state === 'pending' && (by.role !== 'super-admin' || note.length < 10))
      throw new Refusal(
        'The provider may still send this: press Send again to ask it (if it never answers, a super admin records the transfer after checking with the provider, saying so in the note)',
      );
    const who = await nameOf(c, by.id);
    await inTx(c, async () => {
      await record(c, owedEntry, {
        status: 'by-hand',
        paymentId: null,
        ref: reference,
        reason: note || null,
        by: by.id,
        at: now,
      });
      await postEntry(
        c,
        moneyPaidBack({
          owedEntry,
          ref: item.bookingId ?? owedEntry,
          ...(item.brandId ? { brandId: item.brandId } : {}),
          amount: item.amountPaise,
          via: 'bank',
          note: `Bank transfer ${reference} by ${who}`,
          at: now,
        }),
        by.id,
      );
    });
  });
}
