// P3.11.2 in the database: the outside checks on a rider (identity, the agreement, his bank or UPI),
// each started once and its one result kept, and where each stands for the approval checklist.
// A pass counts only with a name that matches his: a check that compared no name proves nothing.
import type {
  BankCheckAdapter,
  EsignAdapter,
  KycAdapter,
  PayoutDestination,
} from '@recall/adapters';
import { namesMatch, RIDER_AGREEMENT, type CheckFact } from '@recall/domain';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { checkDestination } from './payouts.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
export type CheckKind = 'identity' | 'agreement' | 'bank';

/** A fingerprint of an account (to know if the account checked is still the one he has). */
export const accountPrint = (d: PayoutDestination): string =>
  createHash('sha256')
    .update(
      d.kind === 'bank'
        ? `bank:${d.accountNumber}:${d.ifsc}:${d.name.trim().toUpperCase()}`
        : `upi:${d.vpa.toLowerCase()}:${d.name.trim().toUpperCase()}`,
    )
    .digest('hex');

/** An account shown to staff: never the whole number. */
export function maskedAccount(d: PayoutDestination): string {
  return d.kind === 'bank'
    ? `Bank ••••${d.accountNumber.slice(-4)} · ${d.ifsc} · ${d.name}`
    : `UPI ${d.vpa} · ${d.name}`;
}

const newCheckId = () => `CHK-${randomBytes(5).toString('hex').toUpperCase()}`;

/** A rider who may still be checked: he exists and has not left or been turned down. */
async function liveRider(
  c: Q,
  riderId: string,
): Promise<{ name: string; phone: string; status: string }> {
  const r = await c.query<{ name: string; phone: string; status: string }>(
    `SELECT v.name, v.phone,
            (SELECT status FROM rider_steps s WHERE s.rider_id = $1 ORDER BY seq DESC LIMIT 1) AS status
       FROM rider_versions v WHERE v.rider_id = $1 ORDER BY version DESC LIMIT 1`,
    [riderId],
  );
  const x = r.rows[0];
  if (!x) throw new Refusal(`No rider ${riderId}`);
  if (x.status === 'left' || x.status === 'rejected')
    throw new Refusal(`He is ${x.status === 'left' ? 'no longer with RECALL' : 'turned down'}`);
  return x;
}

const recordStart = (
  c: PoolClient,
  checkId: string,
  riderId: string,
  kind: CheckKind,
  ref: string,
  link: string | null,
  about: string,
  by: string,
  now: number,
) =>
  c.query(
    `INSERT INTO rider_checks (check_id, rider_id, kind, provider_ref, link, about, started_by,
                               started_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
    [checkId, riderId, kind, ref.slice(0, 120), link?.slice(0, 500) ?? null, about, by, now],
  );

type Result =
  | { readonly outcome: 'passed'; readonly name: string; readonly idLast4?: string }
  | { readonly outcome: 'failed'; readonly reason: string };

/** Records a check's one result (a second answer for the same check is ignored). */
const recordResult = async (c: Q, checkId: string, r: Result, now: number): Promise<boolean> => {
  const saved = await c.query(
    `INSERT INTO rider_check_results (check_id, outcome, name, id_last4, reason, at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) ON CONFLICT (check_id) DO NOTHING`,
    [
      checkId,
      r.outcome,
      r.outcome === 'passed' ? r.name.trim().slice(0, 120) : null,
      r.outcome === 'passed' ? (r.idLast4 ?? null) : null,
      r.outcome === 'failed' ? r.reason.trim().slice(0, 300) || 'failed' : null,
      now,
    ],
  );
  return (saved.rowCount ?? 0) > 0;
};

/** Starts his identity check: the link for him to open on his phone (the rider app opens it, P4). */
export async function startIdentityCheck(
  pool: Pool,
  kyc: KycAdapter,
  riderId: string,
  by: string,
  now: number,
): Promise<{ link: string }> {
  const r = await liveRider(pool, riderId);
  const s = await kyc.start({ riderId, name: r.name, phone: r.phone });
  await inTransaction(pool, (c) =>
    recordStart(c, newCheckId(), riderId, 'identity', s.ref, s.link, '', by, now),
  );
  return { link: s.link };
}

/** Sends him the rider agreement in force to sign on his phone: the link for him. */
export async function sendAgreement(
  pool: Pool,
  esign: EsignAdapter,
  riderId: string,
  by: string,
  now: number,
): Promise<{ link: string }> {
  const r = await liveRider(pool, riderId);
  const s = await esign.send({
    riderId,
    name: r.name,
    phone: r.phone,
    agreement: RIDER_AGREEMENT.version,
  });
  await inTransaction(pool, (c) =>
    recordStart(
      c,
      newCheckId(),
      riderId,
      'agreement',
      s.ref,
      s.link,
      RIDER_AGREEMENT.version,
      by,
      now,
    ),
  );
  return { link: s.link };
}

/**
 * Checks a bank account or UPI id with a ₹1 test deposit and, if it passes in his own name (the name
 * the bank holds matches the name he gave), makes it where he is paid. An account that fails, or is
 * in another name, is never paid to. The check is kept either way. Once he is approved and has a
 * checked account, only a super admin may move his pay to another one (where money goes: a second
 * pair of eyes, DECISIONS 22 Oct 2026).
 */
export async function checkRiderBank(
  pool: Pool,
  bank: BankCheckAdapter,
  riderId: string,
  to: PayoutDestination,
  by: { readonly who: string; readonly superAdmin: boolean },
  now: number,
): Promise<{ outcome: 'passed' | 'failed'; reason: string | null; nameAtBank: string | null }> {
  const problems = checkDestination(to);
  if (problems.length) throw new Refusal(problems.join('; '));
  if (to.name.trim().length < 2 || to.name.length > 120)
    throw new Refusal('Give the account holder name');
  const rider = await liveRider(pool, riderId);
  if (
    !by.superAdmin &&
    ['approved', 'active', 'paused'].includes(rider.status) &&
    (await payoutAccountOf(pool, riderId))
  )
    throw new Refusal('He is paid to a checked account already: a super admin changes it');
  const answer = await bank.check(to);
  const result: Result =
    answer.state === 'failed'
      ? { outcome: 'failed', reason: answer.reason }
      : !answer.nameAtBank.trim()
        ? { outcome: 'failed', reason: 'the bank gave no name' }
        : !namesMatch(rider.name, answer.nameAtBank)
          ? {
              outcome: 'failed',
              reason: `the bank holds it as "${answer.nameAtBank.trim()}", not "${rider.name}"`,
            }
          : { outcome: 'passed', name: answer.nameAtBank };
  const checkId = newCheckId();
  await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rider:${riderId}`]);
    await recordStart(c, checkId, riderId, 'bank', answer.ref, null, accountPrint(to), by.who, now);
    await recordResult(c, checkId, result, now);
    // Where he is paid: only an account that passed in his name (the payout run checks it again).
    if (result.outcome === 'passed')
      await c.query(
        `INSERT INTO rider_payout_accounts (rider_id, destination, set_by) VALUES ($1, $2, $3)`,
        [riderId, JSON.stringify(to), by.who],
      );
  });
  return result.outcome === 'passed'
    ? { outcome: 'passed', reason: null, nameAtBank: result.name }
    : { outcome: 'failed', reason: result.reason, nameAtBank: null };
}

/** Asks the providers about his identity and agreement checks still waiting; records any answer. */
export async function refreshRiderChecks(
  pool: Pool,
  adapters: { readonly kyc?: KycAdapter; readonly esign?: EsignAdapter },
  riderId: string,
  now: number,
): Promise<number> {
  const waiting = await pool.query<{ check_id: string; kind: CheckKind; provider_ref: string }>(
    `SELECT c.check_id, c.kind, c.provider_ref FROM rider_checks c
      WHERE c.rider_id = $1 AND c.kind IN ('identity', 'agreement')
        AND NOT EXISTS (SELECT 1 FROM rider_check_results r WHERE r.check_id = c.check_id)
      ORDER BY c.seq DESC LIMIT 10`,
    [riderId],
  );
  let answered = 0;
  for (const w of waiting.rows) {
    if (w.kind === 'identity' && adapters.kyc) {
      const s = await adapters.kyc.status(w.provider_ref);
      if (s.state === 'pending') continue;
      // Verified counts only with a name and the last 4 of the ID (nothing compared otherwise).
      const r: Result =
        s.state !== 'verified'
          ? { outcome: 'failed', reason: s.reason }
          : !s.nameOnId.trim()
            ? { outcome: 'failed', reason: 'the provider gave no name' }
            : !/^[A-Za-z0-9]{4}$/.test(s.idLast4)
              ? { outcome: 'failed', reason: 'the provider gave no ID digits' }
              : { outcome: 'passed', name: s.nameOnId, idLast4: s.idLast4 };
      if (await recordResult(pool, w.check_id, r, now)) answered += 1;
    } else if (w.kind === 'agreement' && adapters.esign) {
      const s = await adapters.esign.status(w.provider_ref);
      if (s.state === 'pending') continue;
      const r: Result =
        s.state !== 'signed'
          ? { outcome: 'failed', reason: `declined: ${s.reason}` }
          : s.signerName.trim()
            ? { outcome: 'passed', name: s.signerName }
            : { outcome: 'failed', reason: 'the provider gave no signer name' };
      // Recorded when we learn of it (the provider's clock may be off).
      if (await recordResult(pool, w.check_id, r, now)) answered += 1;
    }
  }
  return answered;
}

export interface CheckView {
  readonly kind: CheckKind;
  readonly state: 'pending' | 'passed' | 'failed';
  /** The link he opens, while it waits (shown only to Operations). */
  readonly link: string | null;
  readonly name: string | null;
  readonly idLast4: string | null;
  readonly reason: string | null;
  readonly about: string;
  readonly startedBy: string;
  readonly startedAt: number;
  readonly at: number | null;
}

/** The newest check of each kind for a rider. */
export async function latestChecks(c: Q, riderId: string): Promise<CheckView[]> {
  const r = await c.query<{
    kind: CheckKind;
    link: string | null;
    about: string;
    started_by: string;
    started_at: Date;
    outcome: 'passed' | 'failed' | null;
    name: string | null;
    id_last4: string | null;
    reason: string | null;
    at: Date | null;
  }>(
    `SELECT DISTINCT ON (c.kind) c.kind, c.link, c.about, c.started_by, c.started_at,
            r.outcome, r.name, r.id_last4, r.reason, r.at
       FROM rider_checks c LEFT JOIN rider_check_results r USING (check_id)
      WHERE c.rider_id = $1 ORDER BY c.kind, c.seq DESC`,
    [riderId],
  );
  const secs = (d: Date) => Math.floor(d.getTime() / 1000);
  return r.rows.map((x) => ({
    kind: x.kind,
    state: x.outcome ?? 'pending',
    link: x.outcome ? null : x.link,
    name: x.name,
    idLast4: x.id_last4,
    reason: x.reason,
    about: x.about,
    startedBy: x.started_by,
    startedAt: secs(x.started_at),
    at: x.at ? secs(x.at) : null,
  }));
}

export interface CheckedAccount {
  readonly shown: string;
  readonly print: string;
  readonly destination: PayoutDestination;
}

/**
 * Where he is paid now: his latest account, only if a ₹1 check passed for exactly that account
 * (otherwise none: an account never checked is never paid to). Masked, with its fingerprint.
 */
export async function payoutAccountOf(c: Q, riderId: string): Promise<CheckedAccount | null> {
  return (await checkedAccounts(c, [riderId])).get(riderId) ?? null;
}

/** Each rider's latest account (all riders: `riderIds` null), for those whose latest passed a ₹1
 * check: the only accounts ever paid to. */
export async function checkedAccounts(
  c: Q,
  riderIds: readonly string[] | null,
): Promise<Map<string, CheckedAccount>> {
  const r = await c.query<{ rider_id: string; destination: PayoutDestination }>(
    `SELECT DISTINCT ON (rider_id) rider_id, destination FROM rider_payout_accounts
      WHERE $1::text[] IS NULL OR rider_id = ANY($1)
      ORDER BY rider_id, set_at DESC`,
    [riderIds],
  );
  const passed = await c.query<{ rider_id: string; about: string }>(
    `SELECT k.rider_id, k.about FROM rider_checks k JOIN rider_check_results x USING (check_id)
      WHERE k.kind = 'bank' AND x.outcome = 'passed'
        AND ($1::text[] IS NULL OR k.rider_id = ANY($1))`,
    [riderIds],
  );
  const ok = new Set(passed.rows.map((p) => `${p.rider_id} ${p.about}`));
  const out = new Map<string, CheckedAccount>();
  for (const a of r.rows) {
    const print = accountPrint(a.destination);
    if (ok.has(`${a.rider_id} ${print}`))
      out.set(a.rider_id, {
        shown: maskedAccount(a.destination),
        print,
        destination: a.destination,
      });
  }
  return out;
}

/** What the approval checklist reads: each check's state, as CheckFacts. */
export async function checkFacts(
  c: Q,
  riderId: string,
): Promise<{ identity: CheckFact; agreement: CheckFact; bank: CheckFact }> {
  const checks = await latestChecks(c, riderId);
  const account = await payoutAccountOf(c, riderId);
  const fact = (kind: CheckKind): CheckFact => {
    const x = checks.find((k) => k.kind === kind);
    if (!x) return null;
    return {
      state: x.state,
      name: x.name,
      current:
        kind === 'agreement'
          ? x.about === RIDER_AGREEMENT.version
          : kind === 'bank'
            ? account?.print === x.about
            : true,
      reason: x.reason,
    };
  };
  return { identity: fact('identity'), agreement: fact('agreement'), bank: fact('bank') };
}
