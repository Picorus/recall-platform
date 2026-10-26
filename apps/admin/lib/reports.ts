// Final campaign reports on the admin site (P3.14.1): where each stands, in words.

export type ReportStage = 'checking' | 'sending' | 'sent' | 'no contact' | 'undelivered';
export type Channel = 'whatsapp' | 'email';

export const STAGE_NAMES: Record<ReportStage, string> = {
  checking: 'Waiting for its last checks',
  sending: 'Built, being sent',
  sent: 'Sent',
  'no contact': 'No phone or email: add one (Brands)',
  undelivered: 'Could not be delivered: check the contact',
};

export const STAGE_CHIP: Record<ReportStage, string> = {
  checking: 'rc-chip--paused',
  sending: 'rc-chip--paused',
  sent: 'rc-chip--go',
  'no contact': 'rc-chip--stop',
  undelivered: 'rc-chip--stop',
};

export interface ReportRow {
  readonly bookingId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly from: number;
  readonly until: number;
  readonly stage: ReportStage;
  readonly builtAt: number | null;
  readonly promised: number | null;
  readonly delivered: number | null;
  readonly deliveredBp: number | null;
  readonly sends: Readonly<
    Partial<Record<Channel, { status: 'sent' | 'failed'; to: string; at: number; tries: number }>>
  >;
}

export interface ReportList {
  readonly at: number;
  readonly rows: readonly ReportRow[];
  readonly canResend: boolean;
  readonly sending: boolean;
}

/** "Sent to chai@example.in" / "Failed (2 tries) to +91…" / "Not sent". */
export function sendText(s: ReportRow['sends'][Channel]): string {
  if (!s) return 'Not sent';
  return s.status === 'sent'
    ? `Sent to ${s.to}`
    : `Failed${s.tries > 1 ? ` (${s.tries} tries)` : ''} to ${s.to}`;
}
