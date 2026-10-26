// P3.10: where each booking line stands, for staff watching delivery. A line is an area-hour a brand
// bought: its plays are counted from the screens (never invented, hard rule 1); if it ends short the
// make-up rules run (makeups.ts): the next 2 hours, then the same hour the next day, then a refund of
// what is still missing, which a super admin approves or rejects. Extra plays are a bonus.
import type { BookingState } from './booking-flow.js';
import { DEFAULT_MAKE_UP_RULES, type MakeUpRules } from './makeups.js';

export interface MakeUpFacts {
  readonly stage: 1 | 2;
  /** UTC seconds: the window is [from, until). */
  readonly from: number;
  readonly until: number;
  /** Plays owed when it was opened, and counted for it so far. */
  readonly owed: number;
  readonly counted: number;
}

export interface LineFacts {
  /** The booking's step now. */
  readonly state: BookingState;
  /** UTC seconds the hour starts. */
  readonly startsAt: number;
  /** UTC seconds the booking's first hour starts (a paid booking's ads may be approved until
   * then); the line's own hour when absent. */
  readonly bookingStartsAt?: number;
  readonly promised: number;
  /** Plays counted for the line itself. */
  readonly counted: number;
  /** The decisions made so far (line_settlements). */
  readonly decided: readonly {
    readonly step: 'first' | 'second' | 'refund';
    readonly outcome: string;
  }[];
  readonly makeUps: readonly MakeUpFacts[];
  readonly refund: {
    readonly missing: number;
    readonly basePaise: number;
    readonly gstPaise: number;
    readonly decision: 'approved' | 'rejected' | null;
  } | null;
}

export type LineStatus =
  | 'not-sold' // a draft or unpaid booking: nothing runs
  | 'cancelled'
  | 'waiting-ads' // paid, its ads not approved yet
  | 'ads-missing' // paid, but no approved ads by the first hour: forfeited, never run
  | 'upcoming'
  | 'live'
  | 'counting' // the hour is over: late uploads still count before the first decision
  | 'delivered'
  | 'make-up' // short: a make-up is booked or running
  | 'short' // short, waiting for the next decision (see `next`)
  | 'short-final' // short, and nothing more will happen (a free trial, or less than a paisa)
  | 'refund-due' // a refund proposed, waiting for a super admin
  | 'refunded'
  | 'refund-rejected';

export interface LineView {
  readonly status: LineStatus;
  /** Plays counted for the line and its make-ups together. */
  readonly delivered: number;
  /** Plays still missing (never below 0; extra plays are a bonus). */
  readonly missing: number;
  /** The make-up booked or running now, if any. */
  readonly makeUp: MakeUpFacts | null;
  /** For a short line: the decision that comes next. */
  readonly next: 'make-up' | 'refund' | null;
  /** Counting: the first decision is late (the job behind, or failing on this line). */
  readonly overdue: boolean;
}

/** A decision more than this late is shown as overdue. */
const OVERDUE_SECONDS = 300;

const RUNS = new Set<BookingState>(['ads-approved', 'running', 'done', 'report-sent']);

/** Where a line stands at `now`. */
export function lineView(
  f: LineFacts,
  now: number,
  rules: MakeUpRules = DEFAULT_MAKE_UP_RULES,
): LineView {
  const delivered = f.counted + f.makeUps.reduce((n, m) => n + m.counted, 0);
  const missing = Math.max(0, Math.min(f.promised, f.promised - delivered));
  const makeUp =
    [...f.makeUps]
      .sort((a, b) => a.from - b.from)
      .find((m) => now < m.until + rules.closeAfterSeconds) ?? null;
  const out = (
    status: LineStatus,
    more: { next?: 'make-up' | 'refund'; overdue?: boolean } = {},
  ): LineView => ({
    status,
    delivered,
    missing,
    makeUp,
    next: more.next ?? null,
    overdue: more.overdue ?? false,
  });
  // A refund first, whatever the booking's step (a paid booking cancelled early gets one too).
  if (f.refund) {
    if (f.refund.decision === 'approved') return out('refunded');
    if (f.refund.decision === 'rejected') return out('refund-rejected');
    return out('refund-due');
  }
  if (f.state === 'cancelled') return out('cancelled');
  if (f.state === 'ads-missing') return out('ads-missing');
  if (f.state === 'paid')
    return out(now < (f.bookingStartsAt ?? f.startsAt) ? 'waiting-ads' : 'ads-missing');
  if (!RUNS.has(f.state)) return out('not-sold');
  if (now < f.startsAt) return out('upcoming');
  if (now < f.startsAt + 3600) return out('live');
  if (f.decided.length === 0)
    return out('counting', {
      overdue: now >= f.startsAt + 3600 + rules.closeAfterSeconds + OVERDUE_SECONDS,
    });
  if (missing === 0) return out('delivered');
  if (makeUp) return out('make-up');
  // The refund decision was made and there is nothing to refund (no refund row).
  if (f.decided.some((d) => d.step === 'refund')) return out('short-final');
  const second = f.decided.some((d) => d.step === 'second');
  return out('short', { next: second ? 'refund' : 'make-up' });
}
