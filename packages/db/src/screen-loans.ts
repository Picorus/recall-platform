// P1.7.8 in the database: the screen loan record (status and EMI dates for the rider app). Never on
// RECALL's books: nothing here touches the ledger.
import { canMoveLoan, loanView, type LoanStatus, type LoanView } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
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
