// P1.7.7: the Monday payout run. The system prepares it from what each rider is owed, finance
// approves it in admin, and the payout provider pays each rider's bank or UPI. A failed payout is
// retried (up to 3 tries); one that keeps failing is given up and shown in admin, and the money
// stays owed to the rider for the next run. TDS was already held back when pay was recorded.
// P3.12: finance works the run in admin: holds a rider's line (not sent until released), drops one
// (its money goes in the next run), and sees each run with what preparing it found.
import type { PayoutDestination, PayoutsAdapter } from '@recall/adapters';
import type { Pool, PoolClient } from 'pg';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { checkedAccounts, maskedAccount } from './rider-checks.js';
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
  if (indiaDate(now) < monday) throw new Refusal('A run is prepared on its Monday, not before');
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
    if (done.rows.length > 0) throw new Refusal(`The run for ${monday} is already prepared`);
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
    // Kept with the run, so finance sees what was found whoever (or whatever) prepared it.
    await c.query('INSERT INTO payout_run_findings (run_id, findings) VALUES ($1, $2)', [
      monday,
      JSON.stringify({ noAccount, payProblems, lateChanges }),
    ]);
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
    throw new Refusal('Only finance or a super admin can approve a payout run');
  await inTransaction(pool, async (c) => {
    const run = await c.query<{ prepared_by: string }>(
      'SELECT prepared_by FROM payout_runs WHERE run_id = $1',
      [runId],
    );
    if (!run.rows[0]) throw new Refusal(`No payout run ${runId}`);
    // Whoever prepared a run by hand cannot approve it too.
    if (run.rows[0].prepared_by === by.id)
      throw new Refusal('Only someone else than who prepared a run can approve it');
    const before = await c.query('SELECT 1 FROM payout_approvals WHERE run_id = $1', [runId]);
    if (before.rows.length > 0) throw new Refusal(`The run for ${runId} is already approved`);
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
  /** Held by finance: not sent until released. */
  readonly held: readonly string[];
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
    if (!got.rows[0]?.ok) throw new Refusal('A payout run is already being sent');
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
  if (approved.rows.length === 0) throw new Refusal(`The run for ${runId} is not approved`);
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
    held: [] as string[],
  };
  // Holds cannot change while this sender holds the send lock (holdPayoutLine takes it too).
  const held = await heldLines(c, runId);
  for (const l of lines.rows) {
    const amount = Number(l.amount);
    const before = await triesOf(c, runId, l.rider_id);
    if (before.last === 'paid' || before.last === 'given up' || before.last === 'cancelled')
      continue;
    // A held line is never sent; one already at the provider (pending) is only asked again.
    if (held.has(l.rider_id) && before.last !== 'pending') {
      out.held.push(l.rider_id);
      continue;
    }
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

/** Riders whose line in a run is held now (their latest hold row says held). */
async function heldLines(c: Q, runId: string): Promise<Set<string>> {
  const r = await c.query<{ rider_id: string }>(
    `SELECT rider_id FROM (SELECT DISTINCT ON (rider_id) rider_id, held FROM payout_holds
                            WHERE run_id = $1 ORDER BY rider_id, seq DESC) h
      WHERE h.held`,
    [runId],
  );
  return new Set(r.rows.map((x) => x.rider_id));
}

const mayRun = (by: { readonly role: string }, what: string) => {
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new Refusal(`Only finance or a super admin can ${what}`);
};

/** Work on a run's lines, never while it is being sent (the send lock), in one transaction. */
async function whileNotSending<T>(pool: Pool, work: (t: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    const got = await c.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('payout-send')) AS ok",
    );
    if (!got.rows[0]?.ok) throw new Refusal('A payout run is being sent: try again after it');
    try {
      return await inClientTransaction(c, async (t) => {
        await t.query("SELECT pg_advisory_xact_lock(hashtext('payouts'))");
        return work(t);
      });
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtext('payout-send'))");
    }
  } finally {
    c.release();
  }
}

/** Who did it, in words: a staff member's name, or the id given. */
async function nameOf(c: Q, id: string): Promise<string> {
  const r = await c.query<{ name: string }>('SELECT name FROM staff WHERE id = $1', [id]);
  return r.rows[0]?.name ?? id;
}

/** Cancels lines never sent, held or failed (all of a run's, or one rider's). */
async function cancelLines(
  pool: Pool,
  runId: string,
  only: string | null,
  text: string,
  now: number,
): Promise<string[]> {
  return whileNotSending(pool, async (t) => {
    const lines = await t.query<{ rider_id: string }>(
      `SELECT rider_id FROM payout_lines WHERE run_id = $1 AND ($2::text IS NULL OR rider_id = $2)
        ORDER BY rider_id`,
      [runId, only],
    );
    if (only !== null && lines.rows.length === 0)
      throw new Refusal(`No line for ${only} in the run for ${runId}`);
    const cancelled: string[] = [];
    for (const l of lines.rows) {
      const before = await triesOf(t, runId, l.rider_id);
      if (before.last !== null && before.last !== 'failed') {
        if (only !== null)
          throw new Refusal(`${only}'s payout is ${before.last}: it cannot be dropped now`);
        continue;
      }
      await record(t, runId, l.rider_id, before.n + 1, 'cancelled', null, text, now);
      cancelled.push(l.rider_id);
    }
    return cancelled;
  });
}

const why = (reason: string, min: number) => {
  const r = reason.trim();
  // eslint-disable-next-line no-control-regex
  if (r.length < min || r.length > 300 || /[\u0000-\u001f\u007f]/.test(r))
    throw new Refusal(`Say why (${min} to 300 letters)`);
  return r;
};

/**
 * Finance or a super admin cancels what is left of a run (lines never sent, held, or failed):
 * their money comes back into the next run. Lines paid or pending at the provider are left alone.
 */
export async function cancelPayoutRun(
  pool: Pool,
  runId: string,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string[]> {
  mayRun(by, 'cancel a payout run');
  const r = why(reason, 5);
  const who = await nameOf(pool, by.id);
  return cancelLines(pool, runId, null, `run cancelled by ${who}: ${r}`, now);
}

/**
 * Drops one rider's line from a run (never sent, held, or failed): his money goes in the next run.
 * For a line finance will not pay this week (a wrong account, a question about his pay).
 */
export async function dropPayoutLine(
  pool: Pool,
  runId: string,
  riderId: string,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  mayRun(by, 'drop a payout');
  const r = why(reason, 5);
  const who = await nameOf(pool, by.id);
  await cancelLines(pool, runId, riderId, `dropped by ${who}: ${r}`, now);
}

/**
 * Holds one rider's line (`held` true: it is not sent until released) or releases it. Only a line
 * not yet at the provider (never sent, or failed) can be held; never while the run is being sent.
 */
export async function holdPayoutLine(
  pool: Pool,
  runId: string,
  riderId: string,
  held: boolean,
  by: { readonly id: string; readonly role: string },
  reason: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  mayRun(by, held ? 'hold a payout' : 'release a payout');
  const r = why(reason, 3);
  await whileNotSending(pool, async (t) => {
    const line = await t.query('SELECT 1 FROM payout_lines WHERE run_id = $1 AND rider_id = $2', [
      runId,
      riderId,
    ]);
    if (line.rows.length === 0) throw new Refusal(`No line for ${riderId} in the run for ${runId}`);
    const before = await triesOf(t, runId, riderId);
    if (before.last !== null && before.last !== 'failed')
      throw new Refusal(`${riderId}'s payout is ${before.last}: it cannot be held or released now`);
    if ((await heldLines(t, runId)).has(riderId) === held)
      throw new Refusal(`${riderId}'s payout is ${held ? 'already held' : 'not held'}`);
    await t.query(
      `INSERT INTO payout_holds (run_id, rider_id, seq, held, reason, by_who, at)
       SELECT $1, $2, coalesce(max(seq), 0) + 1, $3, $4, $5, to_timestamp($6)
         FROM payout_holds WHERE run_id = $1 AND rider_id = $2`,
      [runId, riderId, held, r, by.id, now],
    );
  });
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

/** Where a line stands, in one word, for admin. */
export type LineState =
  'waiting' | 'held' | 'pending' | 'failed' | 'paid' | 'given up' | 'cancelled';

export interface PayoutRunSummary {
  readonly runId: string;
  readonly preparedAt: number;
  readonly preparedBy: string;
  /** Who prepared it, as stored (a staff id, or "system"). */
  readonly preparedById: string;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  readonly lines: number;
  readonly totalPaise: number;
  readonly paidPaise: number;
  /** How many lines stand at each state. */
  readonly states: Readonly<Partial<Record<LineState, number>>>;
}

/** A staff member's name for their id (SQL), or what was stored (system, a test name). */
const WHO = (col: string) => `coalesce((SELECT name FROM staff WHERE id = ${col}), ${col})`;

const secs = (d: Date | null) => (d === null ? null : Math.floor(d.getTime() / 1000));

/**
 * Each line of the runs from `from` to `to` (India dates; null: no limit) with its state now;
 * `open`: only lines not yet paid, given up or dropped.
 */
async function lineStates(c: Q, from: string | null, to: string | null, open = false) {
  const r = await c.query<{
    run_id: string;
    rider_id: string;
    amount: string;
    destination: PayoutDestination;
    last: string | null;
    reason: string | null;
    tries: string;
    held: boolean | null;
    hold_reason: string | null;
  }>(
    `SELECT l.run_id::text AS run_id, l.rider_id, l.amount_paise AS amount, l.destination,
            last.status AS last, last.reason,
            (SELECT count(*) FROM payout_attempts a WHERE a.run_id = l.run_id
               AND a.rider_id = l.rider_id AND a.status IN ('paid', 'pending', 'failed')) AS tries,
            h.held, h.reason AS hold_reason
       FROM payout_lines l
       LEFT JOIN LATERAL (SELECT status, reason FROM payout_attempts a
                           WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
                           ORDER BY attempt DESC LIMIT 1) last ON true
       LEFT JOIN LATERAL (SELECT held, reason FROM payout_holds x
                           WHERE x.run_id = l.run_id AND x.rider_id = l.rider_id
                           ORDER BY seq DESC LIMIT 1) h ON true
      WHERE ($1::date IS NULL OR l.run_id >= $1::date) AND ($2::date IS NULL OR l.run_id <= $2::date)
        AND (NOT $3 OR last.status IS NULL OR last.status IN ('pending', 'failed'))
      ORDER BY l.run_id DESC, l.rider_id`,
    [from, to, open],
  );
  return r.rows.map((x) => {
    // A hold counts only while the line is not at the provider or settled.
    const state: LineState =
      x.held && (x.last === null || x.last === 'failed')
        ? 'held'
        : ((x.last ?? 'waiting') as LineState);
    return {
      runId: x.run_id,
      riderId: x.rider_id,
      amountPaise: Number(x.amount),
      destination: x.destination,
      state,
      reason: state === 'held' ? x.hold_reason : x.reason,
      tries: Number(x.tries),
    };
  });
}

/** The latest runs, newest first, each with its totals and how many lines stand where. */
export async function payoutRuns(c: Q, limit = 26): Promise<PayoutRunSummary[]> {
  return runSummaries(c, limit, null);
}

/** Whether a run was prepared for this Monday. */
export async function payoutRunExists(c: Q, runId: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runId)) return false;
  const r = await c.query('SELECT 1 FROM payout_runs WHERE run_id = $1::date', [runId]);
  return r.rows.length > 0;
}

/**
 * Money still waiting in runs before the latest one: lines held, not sent, failed or pending at the
 * provider. Kept out of every new run until finance releases, sends or drops them, so admin shows
 * them whatever their age.
 */
export async function openOlderLines(
  c: Q,
): Promise<{ runId: string; riderId: string; amountPaise: number; state: LineState }[]> {
  const latest = await c.query<{ run_id: string | null }>(
    'SELECT max(run_id)::text AS run_id FROM payout_runs',
  );
  const before = latest.rows[0]?.run_id;
  if (!before) return [];
  const prev = new Date(Date.parse(`${before}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return (await lineStates(c, null, prev, true)).map((l) => ({
    runId: l.runId,
    riderId: l.riderId,
    amountPaise: l.amountPaise,
    state: l.state,
  }));
}

async function runSummaries(c: Q, limit: number, only: string | null): Promise<PayoutRunSummary[]> {
  const runs = await c.query<{
    run_id: string;
    prepared_at: Date;
    prepared_by: string;
    prepared_by_id: string;
    approved_by: string | null;
    approved_at: Date | null;
  }>(
    `SELECT r.run_id::text AS run_id, r.prepared_at, ${WHO('r.prepared_by')} AS prepared_by,
            r.prepared_by AS prepared_by_id,
            ${WHO('a.approved_by')} AS approved_by, a.approved_at
       FROM payout_runs r LEFT JOIN payout_approvals a USING (run_id)
      WHERE $2::date IS NULL OR r.run_id = $2::date
      ORDER BY r.run_id DESC LIMIT $1`,
    [Math.max(1, Math.min(limit, 200)), only],
  );
  const oldest = runs.rows.at(-1)?.run_id;
  const newest = runs.rows[0]?.run_id;
  const lines =
    oldest && newest
      ? await lineStates(c, oldest, newest)
      : ([] as Awaited<ReturnType<typeof lineStates>>);
  return runs.rows.map((r) => {
    const mine = lines.filter((l) => l.runId === r.run_id);
    const states: Partial<Record<LineState, number>> = {};
    for (const l of mine) states[l.state] = (states[l.state] ?? 0) + 1;
    return {
      runId: r.run_id,
      preparedAt: secs(r.prepared_at) ?? 0,
      preparedBy: r.prepared_by,
      preparedById: r.prepared_by_id,
      approvedBy: r.approved_by,
      approvedAt: secs(r.approved_at),
      lines: mine.length,
      totalPaise: mine.reduce((t, l) => t + l.amountPaise, 0),
      paidPaise: mine.filter((l) => l.state === 'paid').reduce((t, l) => t + l.amountPaise, 0),
      states,
    };
  });
}

export interface PayoutRunPage extends PayoutRunSummary {
  readonly rows: readonly {
    readonly riderId: string;
    readonly amountPaise: number;
    /** Where it is paid, masked (bank: last 4 digits only). */
    readonly to: string;
    readonly state: LineState;
    readonly reason: string | null;
    readonly tries: number;
    /** Every try, hold and release, oldest first. */
    readonly history: readonly { at: number; by: string; text: string }[];
  }[];
  /** What preparing it found (null for a run prepared before P3.12). */
  readonly findings: {
    readonly noAccount: readonly { riderId: string; owedPaise: number }[];
    readonly payProblems: readonly { riderId: string; error: string }[];
    readonly lateChanges: readonly { riderId: string; grossChange: number; month: string }[];
  } | null;
}

/** One run as admin shows it, or null if there is no such run. */
export async function payoutRunPage(c: Q, runId: string): Promise<PayoutRunPage | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runId)) return null;
  const [summary] = await runSummaries(c, 1, runId);
  if (!summary) return null;
  const [lines, attempts, holds, found] = await Promise.all([
    lineStates(c, runId, runId),
    c.query<{ rider_id: string; status: string; reason: string | null; at: Date }>(
      `SELECT rider_id, status, reason, at FROM payout_attempts WHERE run_id = $1
        ORDER BY rider_id, attempt`,
      [runId],
    ),
    c.query<{ rider_id: string; held: boolean; reason: string; by_who: string; at: Date }>(
      `SELECT rider_id, held, reason, ${WHO('by_who')} AS by_who, at FROM payout_holds
        WHERE run_id = $1
        ORDER BY rider_id, seq`,
      [runId],
    ),
    c.query<{ findings: PayoutRunPage['findings'] }>(
      'SELECT findings FROM payout_run_findings WHERE run_id = $1',
      [runId],
    ),
  ]);
  const history = new Map<string, { at: number; by: string; text: string; o: number }[]>();
  const add = (rider: string, e: { at: number; by: string; text: string; o: number }) =>
    history.set(rider, [...(history.get(rider) ?? []), e]);
  attempts.rows.forEach((a, i) =>
    add(a.rider_id, {
      at: secs(a.at) ?? 0,
      by: a.status === 'cancelled' || a.status === 'given up' ? 'system' : 'payout provider',
      text: a.reason ? `${a.status}: ${a.reason}` : a.status,
      o: i,
    }),
  );
  holds.rows.forEach((h, i) =>
    add(h.rider_id, {
      at: secs(h.at) ?? 0,
      by: h.by_who,
      text: `${h.held ? 'held' : 'released'}: ${h.reason}`,
      o: 100_000 + i,
    }),
  );
  return {
    ...summary,
    rows: lines.map((l) => ({
      riderId: l.riderId,
      amountPaise: l.amountPaise,
      to: maskedAccount(l.destination),
      state: l.state,
      reason: l.reason,
      tries: l.tries,
      history: (history.get(l.riderId) ?? [])
        .sort((a, b) => a.at - b.at || a.o - b.o)
        .map(({ at, by, text }) => ({ at, by, text })),
    })),
    findings: found.rows[0]?.findings ?? null,
  };
}

/** The Monday whose run is due at `now` (India time, from 10:00 on a Monday), or null. */
export function payoutRunDue(now: number): string | null {
  const day = indiaDate(now);
  const hour = Math.floor(((((now + 330 * 60) % 86_400) + 86_400) % 86_400) / 3600);
  return new Date(`${day}T00:00:00Z`).getUTCDay() === 1 && hour >= 10 ? day : null;
}

/**
 * Prepares this Monday's run if it is due and not prepared yet (the API calls it every few
 * minutes). Nothing is paid: finance still approves and sends it. Returns the run prepared, if any.
 */
export async function prepareDueRun(pool: Pool, now: number): Promise<PreparedRun | null> {
  const monday = payoutRunDue(now);
  if (!monday) return null;
  const done = await pool.query('SELECT 1 FROM payout_runs WHERE run_id = $1', [monday]);
  if (done.rows.length > 0) return null;
  try {
    return await preparePayoutRun(pool, monday, now, 'system');
  } catch (e) {
    // Prepared by someone else meanwhile (by hand, or another API).
    if (e instanceof Refusal && /already prepared/.test(e.message)) return null;
    throw e;
  }
}
