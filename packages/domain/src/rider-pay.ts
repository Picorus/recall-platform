// P1.7.5–6: what a rider earns in a month. Only moving hours as RECALL counts them from the screen
// (inside the pay zone) count, never app-open time (Prateek, 22 Oct 2026).
//  - POC: a flat base (₹2,000 / ₹4,000 / ₹6,000) plus the ₹6,000 founding bonus in full at 150+
//    moving hours, none below; paid once, after the month ends.
//  - After the POC: ₹25 for each moving hour (up to 260 a month) + 25% of what his hours sold.
// TDS is held back from rider pay at the rate the CA confirms (a setting).
import type { Entry } from './ledger.js';

/** Settings (in the price book, versioned). Amounts in paise, rates in basis points. */
export interface RiderPayRules {
  readonly mode: 'poc' | 'standard';
  /** POC bases a rider can be put on. */
  readonly pocBasesPaise: readonly number[];
  readonly pocBonusPaise: number;
  /** Moving hours in the month (inside the pay zone) for the bonus, in full; none below. */
  readonly pocBonusMinHours: number;
  readonly perMovingHourPaise: number;
  /** Hourly pay is on moving hours up to this many a month (Prateek, 22 Oct 2026). */
  readonly monthlyCapHours: number;
  /** Share of what his hours sold. */
  readonly soldShareBp: number;
  /** TDS held back from rider pay (open question 10b: rate to confirm with the CA). */
  readonly tdsBp: number;
  /** A month's pay is final this long after its last business day ends (late uploads). */
  readonly monthCloseHours: number;
}

export const DEFAULT_RIDER_PAY_RULES: RiderPayRules = {
  mode: 'poc',
  pocBasesPaise: [200_000, 400_000, 600_000],
  pocBonusPaise: 600_000,
  pocBonusMinHours: 150,
  perMovingHourPaise: 2_500,
  monthlyCapHours: 260,
  soldShareBp: 2_500,
  tdsBp: 100,
  monthCloseHours: 48,
};

/** Problems with rider pay settings (empty when they can be saved). */
export function checkRiderPayRules(r: RiderPayRules): string[] {
  const problems: string[] = [];
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (r.mode !== 'poc' && r.mode !== 'standard')
    problems.push('rider pay mode must be poc or standard');
  if (
    r.pocBasesPaise.length === 0 ||
    !r.pocBasesPaise.every(whole) ||
    ![
      r.pocBonusPaise,
      r.pocBonusMinHours,
      r.perMovingHourPaise,
      r.monthlyCapHours,
      r.soldShareBp,
      r.tdsBp,
      r.monthCloseHours,
    ].every(whole)
  )
    problems.push('rider pay settings must be whole numbers');
  if (r.soldShareBp > 10_000 || r.tdsBp > 3_000)
    problems.push('sold share must be at most 100% and TDS at most 30%');
  return problems;
}

/** What a rider did in a month, worked out from the screens he rode. */
export interface RiderMonth {
  /** Moving-clock seconds inside the pay zone. */
  readonly countedSeconds: number;
  /** Of those, up to the monthly cap (260 hours): what hourly pay is worked out on. */
  readonly paidSeconds: number;
  /** What his screens' counted plays sold (paise, before GST; see `soldShares`). */
  readonly soldPaise: number;
  /** POC base he is on (paise); undefined when none was set. */
  readonly pocBasePaise: number | undefined;
}

export interface RiderPay {
  readonly base: number;
  readonly bonus: number;
  readonly hourly: number;
  readonly sold: number;
  readonly gross: number;
  readonly tds: number;
  /** What he is paid: gross less TDS. */
  readonly net: number;
}

const bp = (x: number, rate: number) => Math.floor((x * rate + 5_000) / 10_000);

/**
 * A month's pay. POC pay is 0 until the month has ended (it is paid once, after the month); after
 * the POC, pay grows through the month (paid weekly) and is final once the month has closed.
 */
export function riderPay(rules: RiderPayRules, m: RiderMonth, monthEnded: boolean): RiderPay {
  let base = 0;
  let bonus = 0;
  let hourly = 0;
  let sold = 0;
  if (rules.mode === 'poc') {
    if (monthEnded) {
      base = m.pocBasePaise ?? 0;
      bonus = m.countedSeconds >= rules.pocBonusMinHours * 3600 ? rules.pocBonusPaise : 0;
    }
  } else {
    // ₹25 an hour, to the nearest paisa (halves up), on the capped seconds.
    hourly = Math.floor((m.paidSeconds * rules.perMovingHourPaise * 2 + 3600) / 7200);
    sold = bp(m.soldPaise, rules.soldShareBp);
  }
  const gross = base + bonus + hourly + sold;
  const tds = bp(gross, rules.tdsBp);
  return { base, bonus, hourly, sold, gross, tds, net: gross - tds };
}

/**
 * Shares what a line sold between the screens (or riders) that delivered its counted plays: each
 * counted play is worth `paid ÷ max(promised, counted)`, rounded down per key, so the shares never
 * add up to more than the line was paid (extra plays are a bonus to the brand, not more money).
 */
export function soldShares(
  paid: number,
  promised: number,
  countedKeys: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const per = new Map<string, number>();
  for (const k of countedKeys) per.set(k, (per.get(k) ?? 0) + 1);
  const d = BigInt(Math.max(promised, countedKeys.length));
  if (d === 0n || paid <= 0) return out;
  for (const [k, n] of per) out.set(k, Number((BigInt(paid) * BigInt(n)) / d));
  return out;
}

/**
 * Brings a rider's pay for a month up (or down) to what it is now: rider earnings (an expense), owed
 * to the rider less TDS, the TDS owed to the government. `soFar` is what earlier runs recorded (from
 * the ledger); `n` numbers the entry. Undefined when nothing changed.
 */
export function riderPayAccrued(
  riderId: string,
  month: string,
  pay: { readonly gross: number; readonly tds: number },
  soFar: { readonly gross: number; readonly tds: number },
  n: number,
  at: number,
): Entry | undefined {
  const more = pay.gross - soFar.gross;
  const moreTds = pay.tds - soFar.tds;
  if (more === 0 && moreTds === 0) return undefined;
  const side = (amount: number, usual: 'debit' | 'credit') =>
    amount >= 0 ? usual : usual === 'debit' ? 'credit' : 'debit';
  const postings = (
    [
      ['rider-earnings', side(more, 'debit'), Math.abs(more)],
      ['rider-payable', side(more - moreTds, 'credit'), Math.abs(more - moreTds)],
      ['tds-payable', side(moreTds, 'credit'), Math.abs(moreTds)],
    ] as const
  )
    .filter(([, , amount]) => amount > 0)
    .map(([account, s, amount]) => ({
      account,
      debit: s === 'debit' ? amount : 0,
      credit: s === 'credit' ? amount : 0,
      party: riderId,
    }));
  return {
    entryId: `rider-pay:${riderId}:${month}:${n}`,
    at,
    kind: 'rider-pay',
    ref: `${riderId}/${month}`,
    memo: `Rider ${riderId} pay for ${month}`,
    postings,
  };
}
