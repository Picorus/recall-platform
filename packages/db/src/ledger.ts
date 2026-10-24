// P1.7.1 in the database: posting entries and reading balances. The database checks every entry
// balances when the transaction commits; balances are always summed from the postings.
import { checkEntry, REVERSIBLE_KINDS, type Account, type Entry } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';

type Q = Pick<PoolClient, 'query'>;

export class LedgerError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Ledger entry refused: ${problems.join('; ')}`);
  }
}

/** The same entry as stored, for comparing a repeat with what is already there. */
const sameEntry = (a: Entry, b: Entry) =>
  JSON.stringify([
    a.at,
    a.kind,
    a.ref,
    a.memo,
    a.reverses ?? null,
    a.postings.map((p) => [p.account, p.debit, p.credit, p.party ?? null]),
  ]) ===
  JSON.stringify([
    b.at,
    b.kind,
    b.ref,
    b.memo,
    b.reverses ?? null,
    b.postings.map((p) => [p.account, p.debit, p.credit, p.party ?? null]),
  ]);

/** Reads one entry back (undefined when there is none). */
export async function entryById(c: Q, entryId: string): Promise<Entry | undefined> {
  const e = await c.query<{
    at: string;
    kind: string;
    ref: string;
    memo: string;
    reverses: string | null;
  }>(
    `SELECT extract(epoch FROM at)::bigint AS at, kind, ref, memo, reverses
       FROM ledger_entries WHERE entry_id = $1`,
    [entryId],
  );
  const row = e.rows[0];
  if (!row) return undefined;
  const p = await c.query<{
    account: Account;
    debit: string;
    credit: string;
    party: string | null;
  }>('SELECT account, debit, credit, party FROM ledger_postings WHERE entry_id = $1 ORDER BY n', [
    entryId,
  ]);
  return {
    entryId,
    at: Number(row.at),
    kind: row.kind,
    ref: row.ref,
    memo: row.memo,
    ...(row.reverses === null ? {} : { reverses: row.reverses }),
    postings: p.rows.map((x) => ({
      account: x.account,
      debit: Number(x.debit),
      credit: Number(x.credit),
      ...(x.party === null ? {} : { party: x.party }),
    })),
  };
}

/**
 * Posts an entry inside the caller's transaction (run as `recall_app`). Posting the same entry again
 * changes nothing; a different entry under the same id is refused, so one business event can never
 * be booked twice or two ways.
 */
export async function postEntry(c: Q, e: Entry, postedBy: string): Promise<'posted' | 'already'> {
  const problems = checkEntry(e);
  if (problems.length > 0) throw new LedgerError(problems);
  const existing = await entryById(c, e.entryId);
  if (existing) {
    if (!sameEntry(existing, e)) throw new LedgerError([`${e.entryId} already posted differently`]);
    return 'already';
  }
  if (e.reverses !== undefined) {
    const original = await entryById(c, e.reverses);
    if (!original) throw new LedgerError([`nothing to reverse: ${e.reverses}`]);
    if (!REVERSIBLE_KINDS.has(original.kind))
      throw new LedgerError([`${original.kind} entries are put right by the system, not reversed`]);
  }
  // One call writes the entry and all its postings; the database checks a reversal mirrors its entry.
  await c.query('SELECT ledger_post($1, to_timestamp($2), $3, $4, $5, $6, $7, $8::jsonb)', [
    e.entryId,
    e.at,
    e.kind,
    e.ref,
    e.memo,
    e.reverses ?? null,
    postedBy,
    JSON.stringify(
      e.postings.map((p) => ({
        account: p.account,
        debit: String(p.debit),
        credit: String(p.credit),
        party: p.party ?? null,
      })),
    ),
  ]);
  return 'posted';
}

/** Posts one entry in its own transaction. */
export async function post(pool: Pool, e: Entry, postedBy: string): Promise<'posted' | 'already'> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    const r = await postEntry(c, e, postedBy);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Debits and credits of an account (optionally for one party, or up to a moment), summed from the
 * postings: never a stored running total.
 */
export async function accountTotals(
  c: Q,
  account: Account,
  opts: { readonly party?: string; readonly upTo?: number; readonly ref?: string } = {},
): Promise<{ debit: number; credit: number }> {
  const r = await c.query<{ d: string; c: string }>(
    `SELECT coalesce(sum(p.debit), 0) AS d, coalesce(sum(p.credit), 0) AS c
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE p.account = $1
        AND ($2::text IS NULL OR p.party = $2)
        AND ($3::bigint IS NULL OR e.at <= to_timestamp($3))
        AND ($4::text IS NULL OR e.ref = $4)`,
    [account, opts.party ?? null, opts.upTo ?? null, opts.ref ?? null],
  );
  return { debit: Number(r.rows[0]?.d ?? 0), credit: Number(r.rows[0]?.c ?? 0) };
}

/** Whole-ledger check: total debits equal total credits (they always must). */
export async function trialBalance(c: Q): Promise<{ debit: number; credit: number }> {
  const r = await c.query<{ d: string; c: string }>(
    'SELECT coalesce(sum(debit), 0) AS d, coalesce(sum(credit), 0) AS c FROM ledger_postings',
  );
  return { debit: Number(r.rows[0]?.d ?? 0), credit: Number(r.rows[0]?.c ?? 0) };
}
