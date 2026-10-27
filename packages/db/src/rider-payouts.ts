// P4.6 in the database: the rider app's Payouts page. When he is paid next (every Monday) and about
// how much (what he is owed now: the Monday run works out the final figure), where it goes (his
// checked account, masked), each payout and how it went in words for him, and the tax (TDS) held
// back each quarter for his certificate. Read only; staff's reasons and the provider's notes stay
// with staff.
import type { Pool } from 'pg';
import { payoutAccountOf } from './rider-checks.js';
import { riderMoney } from './rider-fitting.js';

type Q = Pick<Pool, 'query'>;

/** How one payout stands, for the rider. */
export type RiderPayoutState = 'sending' | 'paid' | 'retrying' | 'next-run' | 'held';

export interface RiderPayouts {
  readonly at: number;
  /** The Monday of his next payout ("YYYY-MM-DD", India time). */
  readonly nextDate: string;
  /** What he is owed now (the Monday run works out the final figure). */
  readonly owedPaise: number;
  /** Where he is paid, masked; null when no account has passed its check. */
  readonly account: string | null;
  /** His payouts, newest first (at most 26). */
  readonly history: readonly {
    readonly date: string;
    readonly amountPaise: number;
    readonly state: RiderPayoutState;
  }[];
  /** TDS held back, by quarter of the financial year (newest first). */
  readonly tds: readonly { readonly quarter: string; readonly paise: number }[];
}

const indiaDate = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 10);

/** The Monday of the next payout: today when it is a Monday before 10:00 India time. */
export function nextPayoutDate(now: number): string {
  const today = indiaDate(now);
  const hour = Math.floor(((((now + 330 * 60) % 86_400) + 86_400) % 86_400) / 3600);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const ahead = dow === 1 && hour < 10 ? 0 : (8 - dow) % 7 || 7;
  return new Date(Date.parse(`${today}T00:00:00Z`) + ahead * 86_400_000).toISOString().slice(0, 10);
}

/** "FY2027-28 Q1" (April–June) for an India date. */
export function quarterOf(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const fy = m >= 4 ? y : y - 1;
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  return `FY${fy}-${String((fy + 1) % 100).padStart(2, '0')} Q${q}`;
}

export async function riderPayouts(pool: Q, riderId: string, now: number): Promise<RiderPayouts> {
  const [money, account, lines, tds] = await Promise.all([
    riderMoney(pool, riderId),
    payoutAccountOf(pool, riderId),
    pool.query<{ run_id: string; amount: string; last: string | null; held: boolean | null }>(
      `SELECT l.run_id::text AS run_id, l.amount_paise AS amount, last.status AS last, h.held
         FROM payout_lines l
         LEFT JOIN LATERAL (SELECT status FROM payout_attempts a
                             WHERE a.run_id = l.run_id AND a.rider_id = l.rider_id
                             ORDER BY attempt DESC LIMIT 1) last ON true
         LEFT JOIN LATERAL (SELECT held FROM payout_holds x
                             WHERE x.run_id = l.run_id AND x.rider_id = l.rider_id
                             ORDER BY seq DESC LIMIT 1) h ON true
        WHERE l.rider_id = $1 ORDER BY l.run_id DESC LIMIT 26`,
      [riderId],
    ),
    pool.query<{ at: Date; ref: string; paise: string }>(
      `SELECT e.at, e.ref, p.credit - p.debit AS paise
         FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
        WHERE p.account = 'tds-payable' AND p.party = $1`,
      [riderId],
    ),
  ]);
  const quarters = new Map<string, number>();
  for (const t of tds.rows) {
    // By the month the pay was for ("RD-…/YYYY-MM"), so a later correction lands in its own
    // quarter; otherwise (the finishing bonus) when it was given.
    const month = /\/(\d{4}-\d{2})$/.exec(t.ref)?.[1];
    const q = quarterOf(month ? `${month}-01` : indiaDate(Math.floor(t.at.getTime() / 1000)));
    quarters.set(q, (quarters.get(q) ?? 0) + Number(t.paise));
  }
  return {
    at: now,
    nextDate: nextPayoutDate(now),
    owedPaise: Math.max(0, money.owedPaise),
    account: account?.shown ?? null,
    history: lines.rows.map((l) => ({
      date: l.run_id,
      amountPaise: Number(l.amount),
      state:
        l.last === 'paid'
          ? 'paid'
          : l.held && (l.last === null || l.last === 'failed')
            ? 'held'
            : l.last === 'failed'
              ? 'retrying'
              : l.last === 'given up' || l.last === 'cancelled'
                ? 'next-run'
                : 'sending',
    })),
    tds: [...quarters]
      .filter(([, p]) => p > 0)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([quarter, paise]) => ({ quarter, paise })),
  };
}
