// The weekly payout run on the admin site (P3.12): a run's lines in words.
import { rupees } from './format';

export type LineState =
  'waiting' | 'held' | 'pending' | 'failed' | 'paid' | 'given up' | 'cancelled';

export const STATE_NAMES: Record<LineState, string> = {
  waiting: 'Not sent yet',
  held: 'Held',
  pending: 'Sent, waiting for the bank',
  failed: 'Failed, will be tried again',
  paid: 'Paid',
  'given up': 'Given up (owed next run)',
  cancelled: 'Dropped (owed next run)',
};

export const STATE_CHIP: Record<LineState, string> = {
  waiting: 'rc-chip--paused',
  held: 'rc-chip--paused',
  pending: 'rc-chip--paused',
  failed: 'rc-chip--stop',
  paid: 'rc-chip--go',
  'given up': 'rc-chip--stop',
  cancelled: 'rc-chip--offline',
};

/** The order states are listed in a run's summary. */
const ORDER: readonly LineState[] = [
  'paid',
  'pending',
  'waiting',
  'held',
  'failed',
  'given up',
  'cancelled',
];

export interface RunSummary {
  readonly runId: string;
  readonly preparedAt: number;
  readonly preparedBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  readonly lines: number;
  readonly totalPaise: number;
  readonly paidPaise: number;
  readonly states: Readonly<Partial<Record<LineState, number>>>;
}

export interface RunList {
  readonly at: number;
  readonly runs: readonly RunSummary[];
  /** Money still waiting in older runs (held, not sent, failed, pending). */
  readonly openOlder: readonly {
    runId: string;
    riderId: string;
    amountPaise: number;
    state: LineState;
  }[];
  readonly lastMonday: string;
  readonly dueNow: string | null;
  readonly canAct: boolean;
  readonly canSend: boolean;
}

export interface RunRow {
  readonly riderId: string;
  readonly amountPaise: number;
  readonly to: string;
  readonly state: LineState;
  readonly reason: string | null;
  readonly tries: number;
  readonly history: readonly { at: number; by: string; text: string }[];
}

export interface RunPage extends RunSummary {
  readonly at: number;
  readonly rows: readonly RunRow[];
  readonly findings: {
    readonly noAccount: readonly { riderId: string; owedPaise: number }[];
    readonly payProblems: readonly { riderId: string; error: string }[];
    readonly lateChanges: readonly { riderId: string; grossChange: number; month: string }[];
  } | null;
  readonly canAct: boolean;
  /** Not yet approved, and this member did not prepare it. */
  readonly canApprove: boolean;
}

/** "2 paid · 1 held", in a fixed order. */
export function statesText(s: RunSummary['states']): string {
  const parts = ORDER.filter((k) => (s[k] ?? 0) > 0).map(
    (k) => `${s[k] ?? 0} ${k === 'waiting' ? 'not sent' : k === 'cancelled' ? 'dropped' : k}`,
  );
  return parts.length ? parts.join(' · ') : 'no riders';
}

/** Where a run stands: waiting for approval, ready to send, needs a look, or done. */
export function runStage(r: RunSummary): string {
  if (r.lines === 0) return 'Nothing to pay';
  if (!r.approvedBy) return 'Waiting for approval';
  const open = (['waiting', 'held', 'pending', 'failed'] as const).some(
    (k) => (r.states[k] ?? 0) > 0,
  );
  if (!open) return 'Done';
  return (r.states.waiting ?? 0) === r.lines ? 'Approved, not sent' : 'Being paid';
}

/** "₹1,200 of ₹3,600 paid". */
export function paidText(r: RunSummary): string {
  return `${rupees(r.paidPaise)} of ${rupees(r.totalPaise)} paid`;
}

/** Lines a cancel would move to the next run: not sent, held or failed. */
export const cancellable = (r: RunSummary) =>
  (['waiting', 'held', 'failed'] as const).some((k) => (r.states[k] ?? 0) > 0);

/** Lines that may still be sent (or asked again). */
export const sendable = (r: RunSummary) =>
  (['waiting', 'pending', 'failed'] as const).some((k) => (r.states[k] ?? 0) > 0);
