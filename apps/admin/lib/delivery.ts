// Delivery and make-ups (P3.10): where each booking line stands, in plain words.
import { clock, count, rupees } from './format';

export type LineStatus =
  | 'not-sold'
  | 'cancelled'
  | 'waiting-ads'
  | 'ads-missing'
  | 'upcoming'
  | 'live'
  | 'counting'
  | 'delivered'
  | 'make-up'
  | 'short'
  | 'short-final'
  | 'refund-due'
  | 'refunded'
  | 'refund-rejected';

export interface MakeUpView {
  readonly makeUpId: string;
  readonly stage: 1 | 2;
  readonly from: number;
  readonly until: number;
  readonly owed: number;
  readonly counted: number;
}

export interface DeliveryLine {
  readonly lineId: string;
  readonly bookingId: string;
  readonly brandName: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly date: string;
  readonly startHour: number;
  readonly bikes: number;
  readonly promised: number;
  readonly counted: number;
  readonly bikesSeen: number;
  readonly makeUps: readonly MakeUpView[];
  readonly refund: {
    readonly refundId: string;
    readonly missing: number;
    readonly basePaise: number;
    readonly gstPaise: number;
    readonly decision: 'approved' | 'rejected' | null;
    readonly decidedBy: string | null;
    readonly reason: string | null;
  } | null;
  readonly view: {
    readonly status: LineStatus;
    readonly delivered: number;
    readonly missing: number;
    readonly makeUp: MakeUpView | null;
    readonly next: 'make-up' | 'refund' | null;
    readonly overdue: boolean;
  };
}

export interface DeliveryList {
  readonly lines: readonly DeliveryLine[];
  /** More lines than one answer carries: the rest are not shown. */
  readonly truncated: boolean;
}

/** A status in a word or two (the chip). */
export const STATUS_NAMES: Record<LineStatus, string> = {
  'not-sold': 'Not paid',
  cancelled: 'Cancelled',
  'waiting-ads': 'Waiting for ads',
  'ads-missing': 'Ads missing',
  upcoming: 'Upcoming',
  live: 'Live',
  counting: 'Counting',
  delivered: 'Delivered',
  'make-up': 'Make-up',
  short: 'Short',
  'short-final': 'Short',
  'refund-due': 'Refund due',
  refunded: 'Refunded',
  'refund-rejected': 'Refund rejected',
};

/** The chip's look: fine (go), needs watching (paused), a problem (stop), nothing to do (offline). */
export function statusChip(s: LineStatus): string {
  if (s === 'delivered' || s === 'refunded') return 'rc-chip--go';
  if (s === 'make-up' || s === 'counting' || s === 'live' || s === 'waiting-ads')
    return 'rc-chip--paused';
  if (s === 'short' || s === 'short-final' || s === 'refund-due' || s === 'ads-missing')
    return 'rc-chip--stop';
  return 'rc-chip--offline';
}

const plays = (n: number, of: number) => `${count(n)} of ${count(of)} plays`;

/** "Live: 900 of 1,000 plays", "Short 100: make-up 18:00–20:00, 40 of 100 made up", … */
export function statusText(l: DeliveryLine): string {
  const v = l.view;
  const m = v.makeUp;
  const r = l.refund;
  switch (v.status) {
    case 'not-sold':
      return 'Not paid: does not run';
    case 'cancelled':
      return 'Cancelled';
    case 'waiting-ads':
      return 'Paid: waiting for its ads to be approved';
    case 'ads-missing':
      return 'Ads not approved in time: did not run';
    case 'upcoming':
      return `Upcoming: ${count(l.promised)} plays promised`;
    case 'live':
      return `Live: ${plays(v.delivered, l.promised)}`;
    case 'counting':
      return v.overdue
        ? `Hour over: ${plays(v.delivered, l.promised)}; the make-up decision is late (check the server)`
        : `Hour over, counting late uploads: ${plays(v.delivered, l.promised)}`;
    case 'delivered': {
      const extra = v.delivered - l.promised;
      return `Delivered: ${plays(v.delivered, l.promised)}${extra > 0 ? ` (${count(extra)} extra, free)` : ''}`;
    }
    case 'make-up':
      return m
        ? `Short ${count(v.missing)}: make-up ${m.stage === 1 ? 'in the next hours' : 'the next day'} ${clock(m.from)}–${clock(m.until)}, ${count(m.counted)} of ${count(m.owed)} made up`
        : `Short ${count(v.missing)}: make-up booked`;
    case 'short':
      return v.next === 'refund'
        ? `Short ${count(v.missing)} plays: a refund is worked out a day after the last make-up`
        : `Short ${count(v.missing)} plays: waiting for the next make-up decision`;
    case 'short-final':
      return `Short ${count(v.missing)} plays: nothing to refund (a free trial, or under a paisa)`;
    case 'refund-due':
      return `Short ${count(r?.missing ?? v.missing)}: refund ${rupees(r?.basePaise ?? 0)} + GST ${rupees(r?.gstPaise ?? 0)} proposed (a super admin decides)`;
    case 'refunded':
      return `Refund approved: ${rupees(r?.basePaise ?? 0)} + GST ${rupees(r?.gstPaise ?? 0)} for ${count(r?.missing ?? 0)} missing plays`;
    case 'refund-rejected':
      return `Refund rejected: ${r?.reason ?? ''}`;
  }
}
