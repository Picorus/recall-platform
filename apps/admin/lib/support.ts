// Support on the admin site (P3.15): conversations and where each stands, in words.

export type SupportState = 'open' | 'waiting' | 'done';
export type SupportChannel = 'whatsapp' | 'email' | 'phone' | 'in person';

export const STATE_NAMES: Record<SupportState, string> = {
  open: 'Open',
  waiting: 'Waiting for them',
  done: 'Done',
};

export const STATE_CHIP: Record<SupportState, string> = {
  open: 'rc-chip--stop',
  waiting: 'rc-chip--paused',
  done: 'rc-chip--go',
};

export const CHANNEL_NAMES: Record<SupportChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  phone: 'Call',
  'in person': 'In person',
};

export interface ThreadRow {
  readonly threadId: string;
  readonly channel: SupportChannel;
  readonly contact: string;
  readonly party: { kind: 'rider' | 'brand'; id: string; name: string } | null;
  readonly subject: string;
  readonly state: SupportState;
  readonly owner: string | null;
  readonly ownerId: string | null;
  readonly createdAt: number;
  readonly lastAt: number;
  readonly lastText: string;
  readonly waitingSince: number | null;
}

export interface Inbox {
  readonly at: number;
  readonly rows: readonly ThreadRow[];
  readonly canAct: boolean;
  readonly canReply: boolean;
}

export interface ThreadPage extends ThreadRow {
  /** P4.8: screen problems reported on the rider app, with a link to the photo (10 minutes). */
  readonly problems?: readonly {
    readonly problemId: string;
    readonly kind: string;
    readonly screenId: string | null;
    readonly photo: string | null;
  }[];
  /** The member looking. */
  readonly me: string;
  readonly timeline: readonly {
    at: number;
    kind: 'in' | 'out' | 'note' | 'step';
    by: string;
    text: string;
    status: 'sending' | 'sent' | 'failed' | null;
  }[];
}

/** "Ravi Kumar (rider RD-000012)", "Chai Co (brand)", or the contact. */
export function whoText(r: ThreadRow): string {
  if (!r.party) return r.contact;
  return r.party.kind === 'rider'
    ? `${r.party.name} (rider ${r.party.id})`
    : `${r.party.name} (brand)`;
}

/** "waiting 3 h", "waiting 12 min". */
export function waitText(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60));
  if (m < 60) return `waiting ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `waiting ${h} h` : `waiting ${Math.floor(h / 24)} days`;
}
