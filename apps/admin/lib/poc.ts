// P7.8: what the staff POC page reads (GET /poc, GET /poc/report).
import type { PocPhase, PocRules } from './settings';

export type PocMonthState = 'paid' | 'link-sent' | 'to-pay' | 'missed';

export interface PocMonthView {
  readonly month: string;
  readonly ref: string;
  readonly feePaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly state: PocMonthState;
  readonly payBy: number;
  readonly paidAt: number | null;
  readonly link: { readonly url: string; readonly expiresAt: number } | null;
}

export interface PocDeskBrand {
  readonly brandId: string;
  readonly name: string;
  readonly firstMonth: string;
  readonly months: readonly PocMonthView[];
  readonly ads: readonly { adId: string; name: string; approved: boolean }[];
  readonly addedBy: string;
  readonly addedAt: number;
  readonly playsMonth: number;
  readonly playsToday: number;
}

export interface PocDesk {
  readonly at: number;
  readonly on: boolean;
  readonly since: number | null;
  readonly rules: PocRules;
  readonly perBrand: number;
  readonly month: string;
  readonly openFrom: string;
  readonly brands: readonly PocDeskBrand[];
  readonly bikes: { readonly fitted: number; readonly max: number };
  readonly phase: PocPhase;
  readonly canChange: boolean;
}

export interface PocReport {
  readonly month: string;
  readonly ref: string;
  readonly plays: number;
  readonly bikes: number;
  readonly bikeHours: number;
  readonly days: readonly { day: string; plays: number; bikes: number; bikeHours: number }[];
  readonly months: readonly { month: string; plays: number; bikes: number; bikeHours: number }[];
  readonly streets: readonly { name: string; plays: number }[];
  /** An estimate shown as a range, never billed. */
  readonly people: { readonly text: string };
}

export const MONTH_STATE: Record<PocMonthState, string> = {
  paid: 'Paid',
  'link-sent': 'Link sent',
  'to-pay': 'To pay',
  missed: 'Not paid in time',
};

export const MONTH_CHIP: Record<PocMonthState, string> = {
  paid: 'rc-chip--go',
  'link-sent': 'rc-chip--info',
  'to-pay': 'rc-chip--paused',
  missed: 'rc-chip--stop',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Aug 2027" for "2027-08". */
export const monthShort = (m: string): string =>
  `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`;

/** The month after "YYYY-MM". */
export function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4));
  const mm = Number(m.slice(5, 7));
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
}

/**
 * The months a new brand can start in: from the first not started (`openFrom`), and not past the
 * POC's planned end (India month of the 1st after its months).
 */
export function startMonths(openFrom: string, phase: PocPhase): string[] {
  if (phase.phase !== 'scheduled' && phase.phase !== 'running') return [];
  const end = new Date((phase.plannedEnd + 19_800) * 1000).toISOString().slice(0, 7);
  const start = new Date((phase.startsAt + 19_800) * 1000).toISOString().slice(0, 7);
  const out: string[] = [];
  for (let m = openFrom < start ? start : openFrom; m < end && out.length < 24; m = nextMonth(m))
    out.push(m);
  return out;
}

/** Months a commitment from `first` may run: 1 to the most, never past the planned end. */
export function commitmentMonths(first: string, phase: PocPhase, most: number): number[] {
  const open = startMonths(first, phase);
  return Array.from({ length: Math.min(most, open.length) }, (_, i) => i + 1);
}
