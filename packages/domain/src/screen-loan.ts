// P1.7.8: the screen loan. The bank (Dhanlaxmi Bank, a setting) lends to the rider to buy his
// screen; RECALL only records the loan's status and EMI dates to show in the rider app. Loans and
// EMIs are never on RECALL's books (model v5.2; DECISIONS 22 Oct 2026).

export type LoanStatus = 'applied' | 'approved' | 'rejected' | 'disbursed' | 'closed' | 'defaulted';

/** Which status can follow which. Rejected and closed are final; a default can still be closed. */
const NEXT: Readonly<Record<LoanStatus, readonly LoanStatus[]>> = {
  applied: ['approved', 'rejected'],
  approved: ['disbursed', 'rejected'],
  rejected: [],
  disbursed: ['closed', 'defaulted'],
  defaulted: ['closed'],
  closed: [],
};

export function canMoveLoan(from: LoanStatus, to: LoanStatus): boolean {
  return NEXT[from].includes(to);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The EMI dates: the same day each month from the first EMI (the last day of a shorter month when
 * that day does not exist), `months` of them.
 */
export function emiDates(firstEmi: string, months: number): string[] {
  if (!DATE.test(firstEmi) || Number.isNaN(Date.parse(`${firstEmi}T00:00:00Z`)))
    throw new RangeError('First EMI must be a date (YYYY-MM-DD)');
  if (!Number.isSafeInteger(months) || months < 1 || months > 120)
    throw new RangeError('Months must be 1–120');
  const [y, m, d] = firstEmi.split('-').map(Number) as [number, number, number];
  return Array.from({ length: months }, (_, i) => {
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m - 1 + i, Math.min(d, last))).toISOString().slice(0, 10);
  });
}

export interface LoanView {
  readonly status: LoanStatus;
  /** The next EMI date on or after today (only while the loan runs). */
  readonly nextEmi: string | undefined;
  /** EMI dates still to come, today included. */
  readonly emisLeft: number;
}

/** What the rider app shows for a loan on `today` (India date). */
export function loanView(
  status: LoanStatus,
  firstEmi: string,
  months: number,
  today: string,
): LoanView {
  const left = emiDates(firstEmi, months).filter((d) => d >= today);
  const running = status === 'disbursed' || status === 'defaulted';
  return { status, nextEmi: running ? left[0] : undefined, emisLeft: running ? left.length : 0 };
}
