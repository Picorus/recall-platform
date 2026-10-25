// P1.7.7: the Monday payout run. The system prepares it from what each rider is owed, finance
// approves it in admin, and the payout provider pays each rider's bank or UPI. A failed payout is
// retried (up to 3 tries); one that keeps failing is given up and shown in admin, and the money
// stays owed to the rider for the next run. TDS was already held back when pay was recorded.
import type { PayoutDestination, PayoutsAdapter } from '@recall/adapters';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { accrueRiderPay } from './rider-pay.js';

/** Tries for one payout before it is given up (and shown in admin). */
export const MAX_PAYOUT_TRIES = 3;

const RIDER = /^[A-Za-z0-9-]{3,40}$/;

/** Problems with a payout destination (empty when it can be saved). */
export function checkDestination(d: PayoutDestination): string[] {
  const problems: string[] = [];
  if (d.name.trim().length < 2) problems.push('name of the account holder is needed');
  if (d.kind === 'bank') {
    if (!/^\d{9,18}$/.test(d.accountNumber)) problems.push('account number must be 9–18 digits');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(d.ifsc)) problems.push('IFSC must look like ABCD0123456');
  } else if (!/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.]{1,63}$/.test(d.vpa))
    problems.push('UPI id must look like name@bank');
  return problems;
}

/** Sets where a rider is paid (the latest one is used). */
export async function setPayoutAccount(
  pool: Pool,
  riderId: string,
  destination: PayoutDestination,
  by: string,
): Promise<void> {
  if (!RIDER.test(riderId)) throw new RangeError(`Bad rider id ${riderId}`);
  const problems = checkDestination(destination);
  if (problems.length > 0) throw new RangeError(problems.join('; '));
  await inTransaction(pool, (c) =>
    c.query(
      'INSERT INTO rider_payout_accounts (rider_id, destination, set_by) VALUES ($1, $2, $3)',
      [riderId, JSON.stringify(destination), by],
    ),
  );
}

/** The India date of a moment ("YYYY-MM-DD"). */
const indiaDate = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 10);
const monthOf = (date: string) => date.slice(0, 7);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface PreparedRun {
  readonly runId: string;
  readonly lines: readonly { riderId: string; amountPaise: number }[];
  /** Riders owed money but with no payout account: shown in admin, paid once one is set. */
  readonly noAccount: readonly { riderId: string; owedPaise: number }[];
}

/** What each rider is owed, less what earlier runs are still paying (not paid, not given up). */
async function owedByRider(c: Pick<PoolClient, 'query'>): Promise<Map<string, number>> {
  const r = await c.query<{ rider_id: string; owed: string }>(
    `WITH balance AS (
       SELECT p.party AS rider_id, sum(p.credit - p.debit) AS owed
         FROM ledger_postings p WHERE p.account = 'rider-payable' AND p.party IS NOT NULL
        GROUP BY p.party),
     in_flight AS (
       SELECT l.rider_id, sum(l.amount_paise) AS amount
         FROM payout_lines l
         LEFT JOIN LATERAL (SELECT status FROM payout_attempts a
                             WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
                             ORDER BY attempt DESC LIMIT 1) last ON true
        WHERE last.status IS NULL OR last.status NOT IN ('paid', 'given up')
        GROUP BY l.rider_id)
     SELECT b.rider_id, b.owed - coalesce(f.amount, 0) AS owed
       FROM balance b LEFT JOIN in_flight f USING (rider_id)
      ORDER BY b.rider_id`,
  );
  return new Map(r.rows.map((x) => [x.rider_id, Number(x.owed)]));
}

/**
 * Prepares the Monday run (`monday` is the India date): first brings rider pay up to date, then
 * lists what each rider is owed and where to pay it. Once per Monday; nothing is paid until
 * finance approves.
 */
export async function preparePayoutRun(
  pool: Pool,
  monday: string,
  now: number,
  by = 'system',
): Promise<PreparedRun> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday) || new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1)
    throw new RangeError(`${monday} is not a Monday`);
  if (indiaDate(now) < monday) throw new Error('A run is prepared on its Monday, not before');
  // Pay for the week just ended (it may span two months), and anything late.
  for (const month of new Set([monthOf(addDays(monday, -7)), monthOf(addDays(monday, -1))])) {
    const r = await accrueRiderPay(pool, month, now);
    if (r.failed.length > 0)
      throw new Error(`Rider pay could not be brought up to date: ${r.failed[0]?.error ?? ''}`);
  }
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('payouts'))");
    const done = await c.query('SELECT 1 FROM payout_runs WHERE run_id = $1', [monday]);
    if (done.rows.length > 0) throw new Error(`The run for ${monday} is already prepared`);
    await c.query(
      'INSERT INTO payout_runs (run_id, prepared_at, prepared_by) VALUES ($1, to_timestamp($2), $3)',
      [monday, now, by],
    );
    const accounts = await c.query<{ rider_id: string; destination: PayoutDestination }>(
      `SELECT DISTINCT ON (rider_id) rider_id, destination FROM rider_payout_accounts
        ORDER BY rider_id, set_at DESC`,
    );
    const to = new Map(accounts.rows.map((a) => [a.rider_id, a.destination]));
    const lines: { riderId: string; amountPaise: number }[] = [];
    const noAccount: { riderId: string; owedPaise: number }[] = [];
    for (const [riderId, owed] of await owedByRider(c)) {
      if (owed <= 0) continue;
      const destination = to.get(riderId);
      if (!destination) {
        noAccount.push({ riderId, owedPaise: owed });
        continue;
      }
      await c.query(
        `INSERT INTO payout_lines (run_id, rider_id, amount_paise, destination)
         VALUES ($1, $2, $3, $4)`,
        [monday, riderId, owed, JSON.stringify(destination)],
      );
      lines.push({ riderId, amountPaise: owed });
    }
    return { runId: monday, lines, noAccount };
  });
}

/** Finance (or a super admin) approves a prepared run, once. Nothing is paid before. */
export async function approvePayoutRun(
  pool: Pool,
  runId: string,
  by: { readonly id: string; readonly role: string },
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new Error('Only finance or a super admin can approve a payout run');
  await inTransaction(pool, async (c) => {
    const run = await c.query<{ prepared_by: string }>(
      'SELECT prepared_by FROM payout_runs WHERE run_id = $1',
      [runId],
    );
    if (!run.rows[0]) throw new Error(`No payout run ${runId}`);
    // Whoever prepared a run by hand cannot approve it too.
    if (run.rows[0].prepared_by === by.id) throw new Error('A run is approved by someone else');
    const before = await c.query('SELECT 1 FROM payout_approvals WHERE run_id = $1', [runId]);
    if (before.rows.length > 0) throw new Error(`The run for ${runId} is already approved`);
    await c.query(
      'INSERT INTO payout_approvals (run_id, approved_by, approved_at) VALUES ($1, $2, to_timestamp($3))',
      [runId, by.id, now],
    );
  });
}

export interface SendResult {
  readonly paid: readonly string[];
  readonly pending: readonly string[];
  /** Failed this time, to be tried again. */
  readonly failed: readonly { riderId: string; reason: string }[];
  /** Given up: shown in admin; the money stays owed for the next run. */
  readonly givenUp: readonly { riderId: string; reason: string }[];
}

/**
 * Pays an approved run's lines through the payout provider (safe to call again: it retries what
 * failed or is pending, and never pays a line twice; the provider gets the same key each time).
 * A paid line moves the money from "owed to the rider" to the bank in the ledger.
 */
export async function sendPayoutRun(
  pool: Pool,
  runId: string,
  provider: PayoutsAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SendResult> {
  // One sender at a time for the whole run, held across the provider calls.
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('payout-send')) AS ok",
    );
    if (!got.rows[0]?.ok) throw new Error('A payout run is already being sent');
    try {
      return await sendLines(pool, runId, provider, now);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext('payout-send'))");
    }
  } finally {
    lock.release();
  }
}

async function sendLines(
  pool: Pool,
  runId: string,
  provider: PayoutsAdapter,
  now: number,
): Promise<SendResult> {
  const approved = await pool.query('SELECT 1 FROM payout_approvals WHERE run_id = $1', [runId]);
  if (approved.rows.length === 0) throw new Error(`The run for ${runId} is not approved`);
  const lines = await pool.query<{
    rider_id: string;
    amount: string;
    destination: PayoutDestination;
    tries: string;
    last: string | null;
  }>(
    `SELECT l.rider_id, l.amount_paise AS amount, l.destination,
            (SELECT count(*) FROM payout_attempts a WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id) AS tries,
            (SELECT status FROM payout_attempts a WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
              ORDER BY attempt DESC LIMIT 1) AS last
       FROM payout_lines l WHERE l.run_id = $1 ORDER BY l.rider_id`,
    [runId],
  );
  const out = {
    paid: [] as string[],
    pending: [] as string[],
    failed: [] as { riderId: string; reason: string }[],
    givenUp: [] as { riderId: string; reason: string }[],
  };
  for (const l of lines.rows) {
    if (l.last === 'paid' || l.last === 'given up') continue;
    const tries = Number(l.tries);
    const result = await provider.send({
      payoutKey: `${runId}:${l.rider_id}`,
      riderId: l.rider_id,
      amountPaise: Number(l.amount),
      to: l.destination,
    });
    await inTransaction(pool, async (c) => {
      const record = (attempt: number, status: string, ref: string | null, reason: string | null) =>
        c.query(
          `INSERT INTO payout_attempts (run_id, rider_id, attempt, status, provider_ref, reason, at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
          [runId, l.rider_id, attempt, status, ref, reason, now],
        );
      await record(
        tries + 1,
        result.status,
        result.status === 'failed' ? null : result.providerRef,
        result.status === 'failed' ? result.reason : null,
      );
      if (result.status === 'paid') {
        await postEntry(
          c,
          {
            entryId: `payout:${runId}:${l.rider_id}`,
            at: now,
            kind: 'rider-payout',
            ref: `${l.rider_id}/${runId}`,
            memo: `Payout to ${l.rider_id}, run ${runId} (${result.providerRef})`,
            postings: [
              { account: 'rider-payable', debit: Number(l.amount), credit: 0, party: l.rider_id },
              { account: 'bank', debit: 0, credit: Number(l.amount) },
            ],
          },
          'payouts',
        );
        out.paid.push(l.rider_id);
      } else if (result.status === 'pending') out.pending.push(l.rider_id);
      else if (!result.retryable || tries + 1 >= MAX_PAYOUT_TRIES) {
        await record(tries + 2, 'given up', null, result.reason);
        out.givenUp.push({ riderId: l.rider_id, reason: result.reason });
      } else out.failed.push({ riderId: l.rider_id, reason: result.reason });
    });
  }
  return out;
}

/** A run as admin shows it: each line, its tries and where it stands. */
export async function payoutRunStatus(c: Pick<PoolClient, 'query'>, runId: string) {
  const r = await c.query<{
    rider_id: string;
    amount: string;
    tries: string;
    status: string | null;
    reason: string | null;
  }>(
    `SELECT l.rider_id, l.amount_paise AS amount,
            (SELECT count(*) FROM payout_attempts a WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
               AND a.status <> 'given up') AS tries,
            last.status, last.reason
       FROM payout_lines l
       LEFT JOIN LATERAL (SELECT status, reason FROM payout_attempts a
                           WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
                           ORDER BY attempt DESC LIMIT 1) last ON true
      WHERE l.run_id = $1 ORDER BY l.rider_id`,
    [runId],
  );
  return r.rows.map((x) => ({
    riderId: x.rider_id,
    amountPaise: Number(x.amount),
    tries: Number(x.tries),
    status: x.status ?? 'waiting',
    reason: x.reason,
  }));
}
