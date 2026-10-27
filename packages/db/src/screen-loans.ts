// P1.7.8 in the database: the screen loan record (status and EMI dates for the rider app). Never on
// RECALL's books: nothing here touches the ledger.
import {
  canMoveLoan,
  DEFAULT_RIDER_PAY_RULES,
  isoAt,
  loanView,
  pocFirstMonth,
  priceBookAt,
  type LoanStatus,
  type LoanView,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { businessModes } from './business-mode.js';
import { inTransaction } from './makeups.js';

export interface ScreenLoan {
  readonly loanId: string;
  readonly riderId: string;
  readonly bank: string;
  readonly amountPaise: number;
  readonly emiPaise: number;
  readonly months: number;
  /** "YYYY-MM-DD" */
  readonly firstEmi: string;
}

const isPaise = (n: number) => Number.isSafeInteger(n) && n > 0;

/** Records a loan the bank has taken an application for (status "applied"). */
export async function recordScreenLoan(pool: Pool, loan: ScreenLoan, by: string): Promise<void> {
  if (!isPaise(loan.amountPaise) || !isPaise(loan.emiPaise))
    throw new RangeError('Amounts must be whole paise, more than 0');
  await inTransaction(pool, async (c) => {
    await c.query(
      `INSERT INTO screen_loans (loan_id, rider_id, bank, amount_paise, emi_paise, months, first_emi,
         recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8)`,
      [
        loan.loanId,
        loan.riderId,
        loan.bank,
        loan.amountPaise,
        loan.emiPaise,
        loan.months,
        loan.firstEmi,
        by,
      ],
    );
    await c.query(
      `INSERT INTO screen_loan_events (loan_id, seq, status, set_by) VALUES ($1, 1, 'applied', $2)`,
      [loan.loanId, by],
    );
  });
}

/** Moves a loan to its next status as the bank reports it (only forward). */
export async function moveScreenLoan(
  pool: Pool,
  loanId: string,
  to: LoanStatus,
  by: string,
  note = '',
): Promise<void> {
  await inTransaction(pool, async (c) => {
    // One move of a loan at a time, so two moves never number the same step.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('screen-loan:' || $1))", [loanId]);
    const loan = await c.query('SELECT 1 FROM screen_loans WHERE loan_id = $1', [loanId]);
    if (loan.rows.length === 0) throw new Error(`No screen loan ${loanId}`);
    const last = await c.query<{ seq: number; status: LoanStatus }>(
      'SELECT seq, status FROM screen_loan_events WHERE loan_id = $1 ORDER BY seq DESC LIMIT 1',
      [loanId],
    );
    const now = last.rows[0];
    if (!now || !canMoveLoan(now.status, to))
      throw new Error(`A loan that is ${now?.status ?? 'unknown'} cannot become ${to}`);
    await c.query(
      `INSERT INTO screen_loan_events (loan_id, seq, status, note, set_by) VALUES ($1, $2, $3, $4, $5)`,
      [loanId, now.seq + 1, to, note, by],
    );
  });
}

/** What the rider app shows: each of the rider's loans, its status, next EMI and EMIs left. */
export async function riderLoans(
  c: Pick<PoolClient, 'query'>,
  riderId: string,
  today: string,
): Promise<(ScreenLoan & LoanView)[]> {
  const r = await c.query<{
    loan_id: string;
    bank: string;
    amount: string;
    emi: string;
    months: number;
    first_emi: string;
    status: LoanStatus;
  }>(
    `SELECT l.loan_id, l.bank, l.amount_paise AS amount, l.emi_paise AS emi, l.months,
            l.first_emi::text AS first_emi,
            (SELECT status FROM screen_loan_events e WHERE e.loan_id = l.loan_id
              ORDER BY seq DESC LIMIT 1) AS status
       FROM screen_loans l WHERE l.rider_id = $1 ORDER BY l.recorded_at, l.loan_id`,
    [riderId],
  );
  return r.rows.map((x) => ({
    loanId: x.loan_id,
    riderId,
    bank: x.bank,
    amountPaise: Number(x.amount),
    emiPaise: Number(x.emi),
    months: x.months,
    firstEmi: x.first_emi,
    ...loanView(x.status, x.first_emi, x.months, today),
  }));
}

export interface RiderLoanPage {
  /** His newest loan (a rider has one screen), or null before he applies. */
  readonly loan:
    | (ScreenLoan &
        LoanView & {
          /** When the bank paid it out, "YYYY-MM-DD" (India time), or null. */
          readonly disbursedOn: string | null;
          /** No EMI until the first one (the EMI holiday), while it lasts. */
          readonly holidayUntil: string | null;
        })
    | null;
  /** The bank's name (Settings), for the words before he applies. */
  readonly bank: string;
  /** The bonus for finishing the POC and keeping the screen, toward the loan; null outside a POC. */
  readonly day90: { readonly paise: number; readonly given: boolean } | null;
}

const indiaDate = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * P4.7: the rider app's screen loan page. All of it from the bank's reports as staff record them:
 * RECALL never collects the EMI.
 */
export async function riderLoanPage(
  c: Pick<PoolClient, 'query'>,
  riderId: string,
  now: number,
  bank: string,
): Promise<RiderLoanPage> {
  const today = indiaDate(new Date(now * 1000));
  const loans = await riderLoans(c, riderId, today);
  const loan = loans.at(-1);
  let out: RiderLoanPage['loan'] = null;
  if (loan) {
    const d = await c.query<{ at: Date }>(
      `SELECT set_at AS at FROM screen_loan_events WHERE loan_id = $1 AND status = 'disbursed'
        ORDER BY seq LIMIT 1`,
      [loan.loanId],
    );
    const disbursed = d.rows[0]?.at;
    out = {
      ...loan,
      disbursedOn: disbursed ? indiaDate(disbursed) : null,
      holidayUntil:
        disbursed && loan.status === 'disbursed' && today < loan.firstEmi ? loan.firstEmi : null,
    };
  }
  const given = await c.query<{ paise: string | null }>(
    `SELECT sum(p.debit - p.credit) AS paise FROM ledger_entries e JOIN ledger_postings p USING (entry_id)
      WHERE e.ref = $1 AND p.account = 'rider-earnings' AND p.party = $1
        AND e.kind IN ('poc-finish-bonus', 'poc-finish-bonus-reversed')`,
    [riderId],
  );
  const givenPaise = Number(given.rows[0]?.paise ?? 0);
  // The finishing bonus as the price book has it, once a POC was ever switched on.
  const poc = pocFirstMonth(await businessModes(c)) !== undefined;
  const books = await priceBooks(c);
  const rules =
    (priceBookAt(books, isoAt(now)) ?? books.at(-1))?.riderPay ?? DEFAULT_RIDER_PAY_RULES;
  return {
    loan: out,
    bank,
    day90:
      givenPaise > 0
        ? { paise: givenPaise, given: true }
        : poc
          ? { paise: rules.pocFinishBonusPaise, given: false }
          : null,
  };
}
