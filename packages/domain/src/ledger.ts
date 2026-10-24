// P1.7.1: the ledger. Hard rule 2: money is a double-entry ledger in paise (whole numbers), never
// floats and never a running total. Hard rule 3: nothing is deleted; a mistake is put right by a
// reversing entry. Every booking, delivery, refund and payout is one balanced entry.

/** The accounts (P1.7.1). Assets and expenses grow with debits; the others with credits. */
export const ACCOUNTS = {
  /** Money received from the payment gateway, not yet settled into the bank. */
  'payment-clearing': 'asset',
  bank: 'asset',
  /** GST charged to RECALL by partners (on their cuts), to be claimed back as input tax credit. */
  'gst-input': 'asset',
  /** Paid by brands for campaigns not yet delivered. */
  'campaign-held': 'liability',
  'gst-payable': 'liability',
  'agency-payable': 'liability',
  'aggregator-payable': 'liability',
  'rider-payable': 'liability',
  /** Refunds (with their GST) owed back to brands. */
  'refunds-payable': 'liability',
  'tds-payable': 'liability',
  /** Earned from delivered plays. */
  revenue: 'income',
  'agency-cuts': 'expense',
  'aggregator-cuts': 'expense',
  'rider-earnings': 'expense',
  'gateway-fees': 'expense',
} as const;

export type Account = keyof typeof ACCOUNTS;
export type AccountType = (typeof ACCOUNTS)[Account];

/** One side of an entry: an account, debited or credited a whole number of paise (more than 0). */
export interface Posting {
  readonly account: Account;
  readonly debit: number;
  readonly credit: number;
  /** Who it is about, for the accounts kept per party (a brand, a rider, an agency). */
  readonly party?: string;
}

export interface Entry {
  /** Unique, and chosen so the same business event can only ever be posted once. */
  readonly entryId: string;
  /** When it happened (UTC seconds). */
  readonly at: number;
  readonly kind: string;
  /** What it is about: a booking, a line, a refund, a payout. */
  readonly ref: string;
  readonly memo: string;
  readonly postings: readonly Posting[];
  /** Set on a reversing entry: the entry it undoes. */
  readonly reverses?: string;
}

export type LedgerProblem = string;

const ID = /^[\x21-\x7e]{1,200}$/;

/** Checks an entry before it is posted. Empty when it can be posted. */
export function checkEntry(e: Entry): LedgerProblem[] {
  const problems: LedgerProblem[] = [];
  if (!ID.test(e.entryId)) problems.push('entry id must be 1–200 visible characters');
  if (!Number.isSafeInteger(e.at) || e.at < 0) problems.push('time must be whole UTC seconds');
  if (e.postings.length < 2) problems.push('an entry needs at least two postings');
  let debits = 0;
  let credits = 0;
  for (const p of e.postings) {
    if (!(p.account in ACCOUNTS)) problems.push(`unknown account ${String(p.account)}`);
    const one = (p.debit > 0 ? 1 : 0) + (p.credit > 0 ? 1 : 0);
    if (
      !Number.isSafeInteger(p.debit) ||
      !Number.isSafeInteger(p.credit) ||
      p.debit < 0 ||
      p.credit < 0
    )
      problems.push('amounts must be whole paise, not negative');
    else if (one !== 1) problems.push('each posting is either a debit or a credit, more than 0');
    debits += p.debit;
    credits += p.credit;
  }
  if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits))
    problems.push('amounts too large');
  else if (debits !== credits) problems.push(`not balanced: debits ${debits}, credits ${credits}`);
  return problems;
}

/**
 * Entries made by the system (payments, hour closes, refunds) are put right by the system itself,
 * never reversed by hand, so the figures worked out from them always agree. Only entries made by a
 * person (manual adjustments) may be reversed.
 */
export const REVERSIBLE_KINDS: ReadonlySet<string> = new Set(['manual-adjustment']);

/** The entry that undoes `e` exactly (debits and credits swapped). */
export function reversal(e: Entry, at: number, memo: string): Entry {
  return {
    entryId: `${e.entryId}~reversed`,
    at,
    kind: `${e.kind}-reversed`,
    ref: e.ref,
    memo,
    reverses: e.entryId,
    postings: e.postings.map((p) => ({ ...p, debit: p.credit, credit: p.debit })),
  };
}

/**
 * Balance of each account from its postings, in its natural direction (an asset's balance is debits
 * less credits; a liability's credits less debits). Always worked out from the postings.
 */
export function balances(entries: readonly Entry[]): Map<Account, number> {
  const out = new Map<Account, number>();
  for (const e of entries)
    for (const p of e.postings) {
      const type = ACCOUNTS[p.account];
      const signed =
        type === 'asset' || type === 'expense' ? p.debit - p.credit : p.credit - p.debit;
      out.set(p.account, (out.get(p.account) ?? 0) + signed);
    }
  return out;
}

// ---------------------------------------------------------------- the business events

const post = (
  account: Account,
  side: 'debit' | 'credit',
  paise: number,
  party?: string,
): Posting[] =>
  paise === 0
    ? []
    : [
        {
          account,
          debit: side === 'debit' ? paise : 0,
          credit: side === 'credit' ? paise : 0,
          ...(party === undefined ? {} : { party }),
        },
      ];

/**
 * P1.7.2: a brand pays a booking in advance (subtotal + GST). The money is held for the campaign
 * until plays are delivered; the GST is owed to the government at once (the invoice is issued).
 */
export function bookingPaid(b: {
  readonly bookingId: string;
  readonly brandId: string;
  readonly subtotal: number;
  readonly gst: number;
  readonly paymentId: string;
  readonly at: number;
}): Entry {
  return {
    entryId: `paid:${b.bookingId}:${b.paymentId}`,
    at: b.at,
    kind: 'booking-paid',
    ref: b.bookingId,
    memo: `Booking ${b.bookingId} paid in advance`,
    postings: [
      ...post('payment-clearing', 'debit', b.subtotal + b.gst, b.brandId),
      ...post('campaign-held', 'credit', b.subtotal, b.brandId),
      ...post('gst-payable', 'credit', b.gst),
    ],
  };
}

/**
 * P1.7.3: what a line has earned once `delivered` of its `promised` plays are counted: the delivered
 * share of what was paid for it, rounded down (never more than paid; extra plays are a bonus).
 */
export function earnedPaise(paid: number, promised: number, delivered: number): number {
  if (promised <= 0 || paid <= 0) return 0;
  const d = BigInt(Math.max(0, Math.min(delivered, promised)));
  return Number((BigInt(paid) * d) / BigInt(promised));
}

/**
 * P1.7.3: moves the newly earned part of a line from held to revenue. `earnedSoFar` is what earlier
 * hour closes already moved (worked out from the ledger). If the line has earned less than that
 * (plays later found not to count, e.g. a stolen screen's), the difference goes back to held.
 * Undefined when nothing changed.
 *
 * Revenue comes in two parts, kept apart so cuts can follow delivery: `delivered` (earned by plays,
 * the default) and `kept` (paid but never delivered, kept under the rules: a late cancellation, a
 * refund rejected, ads that never came).
 */
export function lineEarned(l: {
  readonly lineId: string;
  readonly brandId: string;
  readonly earnedNow: number;
  readonly earnedSoFar: number;
  /** A unique label for this hour close (e.g. its time), so a close is never posted twice. */
  readonly closeId: string;
  readonly at: number;
  readonly part?: 'delivered' | 'kept';
}): Entry | undefined {
  const more = l.earnedNow - l.earnedSoFar;
  if (more === 0) return undefined;
  const back = more < 0;
  const kept = l.part === 'kept';
  return {
    entryId: `${kept ? 'kept' : 'earned'}:${l.lineId}:${l.closeId}`,
    at: l.at,
    kind: `${kept ? 'line-kept' : 'line-earned'}${back ? '-back' : ''}`,
    ref: l.lineId,
    memo: kept
      ? back
        ? `Money kept for ${l.lineId} put back to held`
        : `Money kept for ${l.lineId} (paid, not delivered, no refund)`
      : back
        ? `Plays for ${l.lineId} found not to count`
        : `Plays delivered for ${l.lineId}`,
    postings: back
      ? [...post('revenue', 'debit', -more), ...post('campaign-held', 'credit', -more, l.brandId)]
      : [...post('campaign-held', 'debit', more, l.brandId), ...post('revenue', 'credit', more)],
  };
}

/**
 * P1.6.4 into the ledger: an approved refund. The undelivered part leaves "held" and the GST charged
 * on it is given back (the credit note); both are owed back to the brand until paid.
 */
export function refundApproved(r: {
  readonly refundId: string;
  readonly lineId: string;
  readonly brandId: string;
  readonly base: number;
  readonly gst: number;
  readonly at: number;
}): Entry {
  return {
    entryId: `refund:${r.refundId}`,
    at: r.at,
    kind: 'refund-approved',
    ref: r.lineId,
    memo: `Refund ${r.refundId} (credit note)`,
    postings: [
      ...post('campaign-held', 'debit', r.base, r.brandId),
      ...post('gst-payable', 'debit', r.gst),
      ...post('refunds-payable', 'credit', r.base + r.gst, r.brandId),
    ],
  };
}

// ---------------------------------------------------------------- P1.7.4 cuts

/**
 * A cut RECALL decided to give on a booking (Prateek, 24 Oct 2026: never automatic): an agency or an
 * aggregator, its rate, and the GST the partner charges on it (0 when not registered).
 */
export interface Cut {
  readonly bookingId: string;
  readonly kind: 'agency' | 'aggregator';
  readonly partnerId: string;
  readonly rateBp: number;
  readonly gstBp: number;
}

/**
 * Brings a booking's cut up (or down) to its rate on what the booking has delivered so far (cuts
 * are worked out on delivered plays: not on what was invoiced, nor on money kept without delivery). The partner's GST is paid on top and claimed back by
 * RECALL. `soFar` is the cut and GST already recorded (from the ledger); `n` numbers the entry.
 */
export function cutAccrued(
  cut: Cut,
  earned: number,
  soFar: { readonly cut: number; readonly gst: number },
  n: number,
  at: number,
): Entry | undefined {
  const target = Math.floor((earned * cut.rateBp + 5_000) / 10_000);
  const gstTarget = Math.floor((target * cut.gstBp + 5_000) / 10_000);
  const more = target - soFar.cut;
  const moreGst = gstTarget - soFar.gst;
  if (more === 0 && moreGst === 0) return undefined;
  const expense = cut.kind === 'agency' ? 'agency-cuts' : 'aggregator-cuts';
  const payable = cut.kind === 'agency' ? 'agency-payable' : 'aggregator-payable';
  const side = (n2: number, up: 'debit' | 'credit'): 'debit' | 'credit' =>
    n2 >= 0 ? up : up === 'debit' ? 'credit' : 'debit';
  return {
    entryId: `cut:${cut.bookingId}:${cut.kind}:${n}`,
    at,
    kind: `${cut.kind}-cut`,
    ref: cut.bookingId,
    memo: `${cut.kind === 'agency' ? 'Agency' : 'Aggregator'} cut on delivered plays`,
    postings: [
      ...post(expense, side(more, 'debit'), Math.abs(more), cut.partnerId),
      ...post('gst-input', side(moreGst, 'debit'), Math.abs(moreGst), cut.partnerId),
      ...post(payable, side(more + moreGst, 'credit'), Math.abs(more + moreGst), cut.partnerId),
    ],
  };
}
