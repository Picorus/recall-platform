// P1.7.7: the Monday payout run. The system prepares it from what each rider is owed, finance
// approves it in admin, and the payout provider pays each rider's bank or UPI. A failed payout is
// retried (up to 3 tries); one that keeps failing is given up and shown in admin, and the money
// stays owed to the rider for the next run. TDS was already held back when pay was recorded.
import type { PayoutDestination, PayoutsAdapter } from '@recall/adapters';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { checkedAccounts } from './rider-checks.js';
import { accrueRiderPay } from './rider-pay.js';

/** Tries for one payout before it is given up (and shown in admin). */
export const MAX_PAYOUT_TRIES = 3;

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

// Where a rider is paid is set only by a passed ₹1 check in his name (checkRiderBank, P3.11.2).

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
  /** Riders whose pay could not be brought up to date (shown to finance). */
  readonly payProblems: readonly { riderId: string; error: string }[];
  /** Changes found in closed months, for finance to settle by hand. */
  readonly lateChanges: readonly { riderId: string; grossChange: number; month: string }[];
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
        WHERE last.status IS NULL OR last.status NOT IN ('paid', 'given up', 'cancelled')
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
  // Pay for the week just ended (it may span two months), and anything late. A rider whose pay
  // could not be brought up to date is still paid what is recorded (never more than he is owed:
  // each line is checked again when it is sent), and shown to finance.
  const payProblems: { riderId: string; error: string }[] = [];
  const lateChanges: { riderId: string; grossChange: number; month: string }[] = [];
  for (const month of new Set([monthOf(addDays(monday, -7)), monthOf(addDays(monday, -1))])) {
    const r = await accrueRiderPay(pool, month, now);
    payProblems.push(...r.failed);
    lateChanges.push(...r.late.map((x) => ({ ...x, month })));
  }
  return inTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('payouts'))");
    const done = await c.query('SELECT 1 FROM payout_runs WHERE run_id = $1', [monday]);
    if (done.rows.length > 0) throw new Error(`The run for ${monday} is already prepared`);
    await c.query(
      'INSERT INTO payout_runs (run_id, prepared_at, prepared_by) VALUES ($1, to_timestamp($2), $3)',
      [monday, now, by],
    );
    // Only an account that passed a ₹1 check in his name is paid to: anything else (never checked,
    // changed since) is listed for finance as having no account.
    const to = new Map(
      [...(await checkedAccounts(c, null))].map(([id, a]) => [id, a.destination] as const),
    );
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
    return { runId: monday, lines, noAccount, payProblems, lateChanges };
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
  /** Sent, not settled (or no answer): asked again on the next send with the same key. */
  readonly pending: readonly string[];
  /** Failed this time, to be tried again. */
  readonly failed: readonly { riderId: string; reason: string }[];
  /** Given up or cancelled: shown in admin; the money stays owed for the next run. */
  readonly givenUp: readonly { riderId: string; reason: string }[];
}

type Q = Pick<PoolClient, 'query'>;

/** Runs work in a transaction on a client the caller holds (as the app role). */
async function inClientTransaction<T>(c: PoolClient, work: (c: PoolClient) => Promise<T>) {
  await c.query('BEGIN');
  try {
    await c.query('SET LOCAL ROLE recall_app');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

/**
 * Pays an approved run's lines through the payout provider (safe to call again: it retries what
 * failed or is pending, and never pays a line twice; the provider gets the same key each time).
 * Before a line is first sent (or sent again after a failure) it is checked against what the
 * rider is owed now: if he is owed less (a late correction), the line is cancelled and the right
 * amount goes in the next run. A paid line moves the money from "owed to the rider" to the bank.
 */
export async function sendPayoutRun(
  pool: Pool,
  runId: string,
  provider: PayoutsAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SendResult> {
  // One sender at a time for the whole run, held across the provider calls; all work goes through
  // this one connection.
  const c = await pool.connect();
  try {
    const got = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('payout-send')) AS ok",
    );
    if (!got.rows[0]?.ok) throw new Error('A payout run is already being sent');
    try {
      return await sendLines(c, runId, provider, now);
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('payout-send'))");
    }
  } finally {
    c.release();
  }
}

/** A line's tries so far: all attempts (for numbering), failures, and the last status. */
async function triesOf(c: Q, runId: string, riderId: string) {
  const r = await c.query<{ n: string; failed: string; last: string | null }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE status = 'failed') AS failed,
            (SELECT status FROM payout_attempts b WHERE b.run_id = $1 AND b.rider_id = $2
              ORDER BY attempt DESC LIMIT 1) AS last
       FROM payout_attempts a WHERE a.run_id = $1 AND a.rider_id = $2`,
    [runId, riderId],
  );
  return {
    n: Number(r.rows[0]?.n ?? 0),
    failed: Number(r.rows[0]?.failed ?? 0),
    last: r.rows[0]?.last ?? null,
  };
}

/** What a rider is owed now, less his other lines still being paid. */
async function owedBesides(c: Q, runId: string, riderId: string): Promise<number> {
  const r = await c.query<{ owed: string }>(
    `SELECT (SELECT coalesce(sum(credit - debit), 0) FROM ledger_postings
              WHERE account = 'rider-payable' AND party = $2)
          - coalesce((SELECT sum(l.amount_paise) FROM payout_lines l
                       LEFT JOIN LATERAL (SELECT status FROM payout_attempts a
                                           WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
                                           ORDER BY attempt DESC LIMIT 1) last ON true
                      WHERE l.rider_id = $2 AND l.run_id <> $1
                        AND (last.status IS NULL
                             OR last.status NOT IN ('paid', 'given up', 'cancelled'))), 0) AS owed`,
    [runId, riderId],
  );
  return Number(r.rows[0]?.owed ?? 0);
}

async function record(
  c: Q,
  runId: string,
  riderId: string,
  attempt: number,
  status: string,
  ref: string | null,
  reason: string | null,
  now: number,
) {
  await c.query(
    `INSERT INTO payout_attempts (run_id, rider_id, attempt, status, provider_ref, reason, at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))`,
    [runId, riderId, attempt, status, ref, reason, now],
  );
}

async function sendLines(
  c: PoolClient,
  runId: string,
  provider: PayoutsAdapter,
  now: number,
): Promise<SendResult> {
  const approved = await c.query('SELECT 1 FROM payout_approvals WHERE run_id = $1', [runId]);
  if (approved.rows.length === 0) throw new Error(`The run for ${runId} is not approved`);
  const lines = await c.query<{ rider_id: string; amount: string; destination: PayoutDestination }>(
    `SELECT rider_id, amount_paise AS amount, destination FROM payout_lines
      WHERE run_id = $1 ORDER BY rider_id`,
    [runId],
  );
  const out = {
    paid: [] as string[],
    pending: [] as string[],
    failed: [] as { riderId: string; reason: string }[],
    givenUp: [] as { riderId: string; reason: string }[],
  };
  for (const l of lines.rows) {
    const amount = Number(l.amount);
    const before = await triesOf(c, runId, l.rider_id);
    if (before.last === 'paid' || before.last === 'given up' || before.last === 'cancelled')
      continue;
    // Nothing reached the provider yet, or it failed: check the line against what he is owed now.
    // (A pending one may already be paid, so it is only ever asked again.)
    if (before.last !== 'pending') {
      const stop = await inClientTransaction(c, async (t) => {
        await t.query("SELECT pg_advisory_xact_lock(hashtext('payouts'))");
        if ((await owedBesides(t, runId, l.rider_id)) >= amount) return false;
        await record(
          t,
          runId,
          l.rider_id,
          before.n + 1,
          'cancelled',
          null,
          'owed less than this line now (a late correction): the right amount goes in the next run',
          now,
        );
        return true;
      });
      if (stop) {
        out.givenUp.push({ riderId: l.rider_id, reason: 'owed less than this line now' });
        continue;
      }
    }
    let result: Awaited<ReturnType<PayoutsAdapter['send']>>;
    try {
      result = await provider.send({
        payoutKey: `${runId}:${l.rider_id}`,
        riderId: l.rider_id,
        amountPaise: amount,
        to: l.destination,
      });
    } catch (e) {
      // No answer: it may or may not have reached the provider, so it is treated as pending and
      // asked again (same key) on the next send, never given up by itself.
      result = {
        status: 'pending',
        providerRef: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
      };
    }
    const now2 = await triesOf(c, runId, l.rider_id);
    await inClientTransaction(c, async (t) => {
      const n = now2.n + 1;
      if (result.status === 'paid') {
        await record(t, runId, l.rider_id, n, 'paid', result.providerRef, null, now);
        await postEntry(
          t,
          {
            entryId: `payout:${runId}:${l.rider_id}`,
            at: now,
            kind: 'rider-payout',
            ref: `${l.rider_id}/${runId}`,
            memo: `Payout to ${l.rider_id}, run ${runId} (${result.providerRef})`,
            postings: [
              { account: 'rider-payable', debit: amount, credit: 0, party: l.rider_id },
              { account: 'bank', debit: 0, credit: amount },
            ],
          },
          'payouts',
        );
        out.paid.push(l.rider_id);
      } else if (result.status === 'pending') {
        await record(t, runId, l.rider_id, n, 'pending', result.providerRef, null, now);
        out.pending.push(l.rider_id);
      } else {
        await record(t, runId, l.rider_id, n, 'failed', null, result.reason, now);
        // Only failures count as tries (a pending answer is just waiting).
        if (!result.retryable || now2.failed + 1 >= MAX_PAYOUT_TRIES) {
          await record(t, runId, l.rider_id, n + 1, 'given up', null, result.reason, now);
          out.givenUp.push({ riderId: l.rider_id, reason: result.reason });
        } else out.failed.push({ riderId: l.rider_id, reason: result.reason });
      }
    });
  }
  return out;
}

/**
 * Finance or a super admin cancels what is left of a run (lines never sent, or failed): their
 * money comes back into the next run. Lines paid or pending at the provider are left alone.
 */
export async function cancelPayoutRun(
  pool: Pool,
  runId: string,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string[]> {
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new Error('Only finance or a super admin can cancel a payout run');
  if (reason.trim().length < 5) throw new Error('Say why the run is cancelled');
  const c = await pool.connect();
  try {
    const got = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('payout-send')) AS ok",
    );
    if (!got.rows[0]?.ok) throw new Error('A payout run is being sent: try again after it');
    try {
      return await inClientTransaction(c, async (t) => {
        await t.query("SELECT pg_advisory_xact_lock(hashtext('payouts'))");
        const lines = await t.query<{ rider_id: string }>(
          'SELECT rider_id FROM payout_lines WHERE run_id = $1 ORDER BY rider_id',
          [runId],
        );
        const cancelled: string[] = [];
        for (const l of lines.rows) {
          const before = await triesOf(t, runId, l.rider_id);
          if (before.last !== null && before.last !== 'failed') continue;
          await record(
            t,
            runId,
            l.rider_id,
            before.n + 1,
            'cancelled',
            null,
            `run cancelled by ${by.id}: ${reason}`,
            now,
          );
          cancelled.push(l.rider_id);
        }
        return cancelled;
      });
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('payout-send'))");
    }
  } finally {
    c.release();
  }
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
               AND a.status IN ('paid', 'pending', 'failed')) AS tries,
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
