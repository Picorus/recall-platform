// Riders on the admin site (P3.11.1): their steps in words, what each step may go to, and the
// pieces of a rider's page.

export type RiderStatus = 'applied' | 'approved' | 'rejected' | 'active' | 'paused' | 'left';
export type DocumentKind = 'photo' | 'rc' | 'insurance';

export const STATUS_NAMES: Record<RiderStatus, string> = {
  applied: 'Applied',
  approved: 'Approved',
  rejected: 'Rejected',
  active: 'Riding',
  paused: 'Paused',
  left: 'Left',
};

export const STATUS_CHIP: Record<RiderStatus, string> = {
  applied: 'rc-chip--paused',
  approved: 'rc-chip--go',
  rejected: 'rc-chip--stop',
  active: 'rc-chip--go',
  paused: 'rc-chip--paused',
  left: 'rc-chip--offline',
};

/** The steps a rider may take next (the server checks them again), with the button's words. */
export const NEXT_STEPS: Record<RiderStatus, readonly { to: RiderStatus; label: string }[]> = {
  applied: [
    { to: 'approved', label: 'Approve' },
    { to: 'rejected', label: 'Reject' },
    { to: 'left', label: 'Withdrew' },
  ],
  approved: [
    { to: 'active', label: 'Riding (screen fitted)' },
    { to: 'paused', label: 'Pause' },
    { to: 'left', label: 'Left RECALL' },
  ],
  active: [
    { to: 'paused', label: 'Pause' },
    { to: 'left', label: 'Left RECALL' },
  ],
  paused: [
    { to: 'active', label: 'Riding again' },
    { to: 'left', label: 'Left RECALL' },
  ],
  rejected: [{ to: 'applied', label: 'Look again' }],
  left: [{ to: 'applied', label: 'Rejoins' }],
};

export const DOCUMENT_NAMES: Record<DocumentKind, string> = {
  photo: 'Photo',
  rc: 'Registration (RC)',
  insurance: 'Insurance',
};

export const APPS = [
  'swiggy',
  'zomato',
  'zepto',
  'blinkit',
  'instamart',
  'rapido',
  'uber',
  'ola',
  'porter',
  'other',
] as const;

export interface RiderRow {
  readonly riderId: string;
  readonly status: RiderStatus;
  readonly version: number;
  readonly createdAt: number;
  readonly name: string;
  readonly phone: string;
  readonly bikePlate: string | null;
  readonly rides: string;
  readonly apps: readonly string[];
}

export interface RiderDocument {
  readonly docId: string;
  readonly kind: DocumentKind;
  readonly fileType: 'png' | 'jpeg' | 'webp' | 'pdf';
  readonly bytes: number;
  readonly uploadedBy: string;
  readonly uploadedAt: number;
  readonly preview: string | null;
  readonly review: {
    readonly decision: 'accepted' | 'rejected';
    readonly reason: string;
    readonly expiresOn: string | null;
    readonly by: string;
    readonly at: number;
  } | null;
}

export interface CheckView {
  readonly kind: 'identity' | 'agreement' | 'bank';
  readonly state: 'pending' | 'passed' | 'failed';
  readonly link: string | null;
  readonly name: string | null;
  readonly idLast4: string | null;
  readonly reason: string | null;
  readonly startedAt: number;
  readonly at: number | null;
}

export const CHECKS = [
  { kind: 'identity', name: 'Identity (KYC)' },
  { kind: 'agreement', name: 'Agreement' },
  { kind: 'bank', name: 'Bank or UPI' },
] as const;

/** "Passed: RAVI KUMAR (ID ••••1234)", "Waiting for him", "Failed: account closed", "Not started". */
export function checkText(c: CheckView | undefined): string {
  if (!c) return 'Not started';
  if (c.state === 'pending') return 'Waiting for him';
  if (c.state === 'failed') return `Failed: ${c.reason ?? ''}`;
  const id = c.idLast4 ? ` (ID ••••${c.idLast4})` : '';
  return c.name ? `Passed: ${c.name}${id}` : 'Passed';
}

export interface FittingSlot {
  readonly slotId: string;
  readonly centre: string;
  readonly startsAt: number;
  readonly minutes: number;
  readonly bikes: number;
  readonly booked: readonly string[];
}

export interface RiderMoney {
  readonly owedPaise: number;
  readonly payouts: readonly {
    runId: string;
    amountPaise: number;
    status: string;
    reason: string | null;
  }[];
}

export interface RiderPage {
  readonly at: number;
  readonly rider: RiderRow;
  readonly channel: 'app' | 'admin';
  readonly checklist: readonly { item: string; done: boolean; detail: string }[];
  readonly screenId: string | null;
  readonly documents: readonly RiderDocument[];
  readonly checks: readonly CheckView[];
  readonly payoutAccount: string | null;
  readonly fitting: FittingSlot | null;
  readonly money: RiderMoney;
  readonly leaving: readonly { item: string; done: boolean; detail: string }[];
  readonly timeline: readonly { at: number; by: string; text: string }[];
}

/** "+91 98480 12345". */
export function phoneText(p: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(p);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

/** "Accepted (until 2028-03-31)", "Rejected: blurred", "Waiting for a look". */
export function documentStatus(d: RiderDocument): string {
  if (!d.review) return 'Waiting for a look';
  if (d.review.decision === 'rejected') return `Rejected: ${d.review.reason}`;
  return d.review.expiresOn ? `Accepted (covers until ${d.review.expiresOn})` : 'Accepted';
}

/** "Wed 2 Jun, 10:00 · 2 h · Kukatpally warehouse (1 of 4 booked)". */
export function slotText(s: FittingSlot, when: (t: number) => string): string {
  const h = s.minutes % 60 === 0 ? `${s.minutes / 60} h` : `${s.minutes} min`;
  return `${when(s.startsAt)} · ${h} · ${s.centre} (${s.booked.length} of ${s.bikes} booked)`;
}
