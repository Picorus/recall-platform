// P1.7.5–6: what a rider earns. Only moving hours as RECALL counts them from the screen (inside the
// pay zone) count, never app-open time (Prateek, 22 Oct 2026).
//  - POC (Prateek, 24 Oct 2026; model v5.2), while the business switch is on POC (see
//    business-mode.ts), counted from the month it was first switched on. A flat base that
//    rises each month (₹2,000 / ₹4,000 / ₹6,000), earned day by day and paid weekly, + a founding
//    bonus of up to ₹6,000 a month on the month's verified moving hours (full at 150+, in proportion
//    from 100 to 150, none below 100), given by a super admin once the month has closed. No sales
//    share in the POC. Riders who finish the POC and keep the screen get ₹3,000 more.
//  - After the POC: ₹25 for each moving hour (up to 260 a month) + 25% of what his hours sold,
//    after the agency and aggregator cuts on the booking (Prateek, 29 Oct 2026).
// TDS is held back from rider pay at the rate the CA confirms (a setting).
import type { Entry } from './ledger.js';

/** Settings (in the price book, versioned). Amounts in paise, rates in basis points. */
export interface RiderPayRules {
  /** Flat base for each POC month, in order (₹2,000, ₹4,000, ₹6,000); the last one after that. */
  readonly pocBasesPaise: readonly number[];
  /** Founding bonus a month, in full at `pocBonusFullHours`. */
  readonly pocBonusPaise: number;
  readonly pocBonusFullHours: number;
  /** Below this many hours in the month, no bonus; in between, in proportion. */
  readonly pocBonusFromHours: number;
  /** For riders who finish the POC and keep the screen. */
  readonly pocFinishBonusPaise: number;
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
  pocBasesPaise: [200_000, 400_000, 600_000],
  pocBonusPaise: 600_000,
  pocBonusFullHours: 150,
  pocBonusFromHours: 100,
  pocFinishBonusPaise: 300_000,
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
  if (
    r.pocBasesPaise.length === 0 ||
    !r.pocBasesPaise.every(whole) ||
    ![
      r.pocBonusPaise,
      r.pocBonusFullHours,
      r.pocBonusFromHours,
      r.pocFinishBonusPaise,
      r.perMovingHourPaise,
      r.monthlyCapHours,
      r.soldShareBp,
      r.tdsBp,
      r.monthCloseHours,
    ].every(whole)
  )
    problems.push('rider pay settings must be whole numbers');
  // A switch reaches back to 08:00 of its day: a month must stay open longer than that.
  if (r.monthCloseHours < 24)
    problems.push('a month must stay open at least 24 hours after it ends');
  if (r.pocBonusFromHours >= r.pocBonusFullHours)
    problems.push('the bonus must start below the hours for the full bonus');
  if (r.soldShareBp > 10_000 || r.tdsBp > 3_000)
    problems.push('sold share must be at most 100% and TDS at most 30%');
  return problems;
}

/** Which POC month `month` is (1, 2, 3…) when the POC was first switched on in `firstMonth`. */
export function pocMonthOf(firstMonth: string | undefined, month: string): number | undefined {
  if (firstMonth === undefined) return undefined;
  const [sy, sm] = firstMonth.split('-').map(Number) as [number, number];
  const [y, m] = month.split('-').map(Number) as [number, number];
  const n = (y - sy) * 12 + (m - sm) + 1;
  return n >= 1 ? n : undefined;
}

/** The flat base of POC month `n` (the last one if the POC runs longer than planned). */
export function pocBaseOf(rules: RiderPayRules, n: number): number {
  const bases = rules.pocBasesPaise;
  return bases[Math.min(Math.max(n, 1), bases.length) - 1] ?? 0;
}

/**
 * The POC base for one day of a month: the month's base spread over its days, rounded down day by
 * day so a full month adds up to exactly the base (the last day takes the leftover paise).
 */
export function pocDayPaise(monthPaise: number, daysInMonth: number, day: number): number {
  const upTo = (d: number) => Math.floor((monthPaise * d) / daysInMonth);
  return upTo(day) - upTo(day - 1);
}

/**
 * A POC month's founding bonus on its verified moving seconds: in full at 150 hours or more, none
 * below 100, in proportion in between (125 h = 50% = ₹3,000; 140 h = 80% = ₹4,800), rounded down.
 */
export function pocMonthBonus(rules: RiderPayRules, countedSeconds: number): number {
  const from = rules.pocBonusFromHours * 3600;
  const full = rules.pocBonusFullHours * 3600;
  if (countedSeconds >= full) return rules.pocBonusPaise;
  if (countedSeconds < from) return 0;
  return Math.floor((rules.pocBonusPaise * (countedSeconds - from)) / (full - from));
}

/** What a rider did in a month, worked out from the screens he rode. */
export interface RiderMonth {
  /** Moving-clock seconds inside the pay zone, under regular business. */
  readonly countedSeconds: number;
  /** Of those, up to the monthly cap (260 hours): what hourly pay is worked out on. */
  readonly paidSeconds: number;
  /** What his screens' counted plays sold under regular business (paise, before GST). */
  readonly soldPaise: number;
  /** POC: the days of the month (1…31) under the POC that he held a screen, of those ended. */
  readonly pocDays: readonly number[];
  readonly daysInMonth: number;
}

export interface RiderPay {
  /** POC base earned so far this month. */
  readonly poc: number;
  readonly hourly: number;
  readonly sold: number;
  readonly gross: number;
  readonly tds: number;
  /** What he is paid: gross less TDS. */
  readonly net: number;
}

const bp = (x: number, rate: number) => Math.floor((x * rate + 5_000) / 10_000);

/**
 * A month's pay so far (bonuses apart): the month's POC base for each POC day he held a screen
 * (`pocMonth` is which POC month this is), + ₹25 a moving hour (capped) + 25% of what his plays
 * sold under regular business. A month the switch was flipped in has both parts. All of it grows
 * through the month and is paid weekly.
 */
export function riderPay(
  rules: RiderPayRules,
  pocMonth: number | undefined,
  m: RiderMonth,
): RiderPay {
  const base = pocMonth === undefined ? 0 : pocBaseOf(rules, pocMonth);
  const poc = [...new Set(m.pocDays)].reduce(
    (sum, d) => sum + pocDayPaise(base, m.daysInMonth, d),
    0,
  );
  // ₹25 an hour, to the nearest paisa (halves up), on the capped seconds.
  const hourly = Math.floor((m.paidSeconds * rules.perMovingHourPaise * 2 + 3600) / 7200);
  const sold = bp(m.soldPaise, rules.soldShareBp);
  const gross = poc + hourly + sold;
  const tds = bp(gross, rules.tdsBp);
  return { poc, hourly, sold, gross, tds, net: gross - tds };
}

/**
 * A POC bonus a super admin gives (P1.7.6), less TDS: a month's founding bonus (`month` set) or
 * the bonus for finishing the POC and keeping the screen.
 */
export function pocBonusEntry(
  rules: RiderPayRules,
  riderId: string,
  gross: number,
  month: string | undefined,
  at: number,
): Entry {
  const tds = bp(gross, rules.tdsBp);
  const postings = [
    { account: 'rider-earnings' as const, debit: gross, credit: 0, party: riderId },
    { account: 'rider-payable' as const, debit: 0, credit: gross - tds, party: riderId },
    ...(tds > 0
      ? [{ account: 'tds-payable' as const, debit: 0, credit: tds, party: riderId }]
      : []),
  ];
  return month === undefined
    ? {
        entryId: `poc-finish:${riderId}`,
        at,
        kind: 'poc-finish-bonus',
        ref: riderId,
        memo: `Bonus for ${riderId}: finished the POC and kept the screen`,
        postings,
      }
    : {
        entryId: `poc-bonus:${riderId}:${month}`,
        at,
        kind: 'poc-bonus',
        ref: `${riderId}/${month}`,
        memo: `Founding bonus for ${riderId}, ${month}`,
        postings,
      };
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
