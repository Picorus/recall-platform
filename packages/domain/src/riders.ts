// P3.11.1: riders as staff see them. A rider applies (in the rider app, P4, or at the warehouse through
// Operations), sends his photo and his vehicle's registration and insurance, is approved, gets a
// screen fitted, rides, may pause, and may leave (after the screen comes off). Each step is logged
// with who and why; details change as versions (hard rule 3). Identity (KYC), the agreement and the
// bank check come in P3.11.2 and join the approval checklist then.
import { adKind } from './ad-checks.js';

export const RIDER_STATUSES = [
  'applied',
  'approved',
  'rejected',
  'active',
  'paused',
  'left',
] as const;
export type RiderStatus = (typeof RIDER_STATUSES)[number];

/** Where each status may go next. */
const NEXT: Readonly<Record<RiderStatus, readonly RiderStatus[]>> = {
  applied: ['approved', 'rejected', 'left'],
  approved: ['active', 'paused', 'left'],
  active: ['paused', 'left'],
  paused: ['active', 'left'],
  // A rejected or departed rider may apply again (a new look at the same record).
  rejected: ['applied'],
  left: ['applied'],
};

/** Rider ids: "RD-" and 6 digits, given in order ("RD-000123"), easy to read on a call. */
export const RIDER_ID = /^RD-\d{6}$/;
export const riderIdOf = (n: number): string => `RD-${String(n).padStart(6, '0')}`;

/** The delivery and ride apps a rider may work for (what he says; shown to Operations). */
export const RIDER_APPS = [
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
export type RiderApp = (typeof RIDER_APPS)[number];

/** Documents a rider sends (P4.2.1–2): his photo, his vehicle's registration and insurance. */
export const RIDER_DOCUMENTS = ['photo', 'rc', 'insurance'] as const;
export type RiderDocumentKind = (typeof RIDER_DOCUMENTS)[number];
export const DOCUMENT_NAMES: Readonly<Record<RiderDocumentKind, string>> = {
  photo: 'Photo',
  rc: 'Registration (RC)',
  insurance: 'Insurance',
};
/** Largest document file (a phone photo or a scan). */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export type DocumentFileType = 'png' | 'jpeg' | 'webp' | 'pdf';
export const DOCUMENT_CONTENT_TYPE: Readonly<Record<DocumentFileType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

/** What a document file really is, from its first bytes (never its name): a picture or a PDF. */
export function documentFileType(b: Uint8Array): DocumentFileType | null {
  const k = adKind(b);
  if (k === 'png' || k === 'jpeg' || k === 'webp') return k;
  return b.length > 8 && String.fromCharCode(...b.subarray(0, 5)) === '%PDF-' ? 'pdf' : null;
}

export interface RiderDetails {
  readonly name: string;
  /** "+91" and 10 digits. */
  readonly phone: string;
  /** Number plate in one form ("TS09EA1234"), as screens' fittings store it; null until known. */
  readonly bikePlate: string | null;
  /** Where he usually rides, in his words. */
  readonly rides: string;
  readonly apps: readonly RiderApp[];
}

/** An Indian mobile number in one form: "+91" and 10 digits starting 6–9; null if it is not one. */
export function phoneOf(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, '').replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

/** A number plate in one form: capitals and digits only ("TS 09 EA 1234" → "TS09EA1234"), as
 * screens' fittings store it (state plates and the newer "BH" plates alike). */
export function plateOf(raw: string): string | null {
  const p = raw.toUpperCase().replace(/[\s.-]/g, '');
  return /^[A-Z0-9]{4,12}$/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) ? p : null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What is wrong with a rider's details (empty when they can be saved). */
export function riderProblems(d: RiderDetails): string[] {
  const out: string[] = [];
  const name = d.name.trim();
  if (name.length < 2 || name.length > 80 || CONTROL.test(name))
    out.push('name must be 2 to 80 letters');
  if (phoneOf(d.phone) !== d.phone) out.push('phone must be an Indian mobile number');
  if (d.bikePlate !== null && plateOf(d.bikePlate) !== d.bikePlate)
    out.push('number plate: 4 to 12 letters and digits (e.g. TS09EA1234)');
  if (d.rides.length > 120 || CONTROL.test(d.rides))
    out.push('where he rides: at most 120 letters');
  if (new Set(d.apps).size !== d.apps.length || !d.apps.every((a) => RIDER_APPS.includes(a)))
    out.push('apps must be from the list, each once');
  return out;
}

/** The latest review of each document kind the rider sent, as the checklist needs it. */
export interface DocumentState {
  readonly kind: RiderDocumentKind;
  readonly decision: 'accepted' | 'rejected' | null;
  /** Insurance: the last day it covers ("YYYY-MM-DD"). */
  readonly expiresOn: string | null;
}

export interface RiderFacts {
  readonly status: RiderStatus;
  readonly details: RiderDetails;
  /** The newest document of each kind (none sent: absent). */
  readonly documents: readonly DocumentState[];
  /** A screen is fitted to him now (screens' fittings). */
  readonly screenFitted: boolean;
}

export interface CheckItem {
  readonly item: string;
  readonly done: boolean;
  readonly detail: string;
}

/** The India date of a UTC instant (seconds). */
const indiaDate = (s: number) => new Date((s + 19_800) * 1000).toISOString().slice(0, 10);

/** What approval needs, each ticked or not (P3.11.2 adds identity, agreement and bank). */
export function approvalChecklist(f: RiderFacts, now: number): CheckItem[] {
  const doc = (kind: RiderDocumentKind): CheckItem => {
    const d = f.documents.find((x) => x.kind === kind);
    const name = DOCUMENT_NAMES[kind];
    if (!d) return { item: name, done: false, detail: 'not sent' };
    if (d.decision === null) return { item: name, done: false, detail: 'waiting for a look' };
    if (d.decision === 'rejected')
      return { item: name, done: false, detail: 'rejected: send again' };
    if (kind === 'insurance' && (d.expiresOn === null || d.expiresOn < indiaDate(now)))
      return { item: name, done: false, detail: `expired ${d.expiresOn ?? ''}`.trim() };
    return {
      item: name,
      done: true,
      detail: kind === 'insurance' ? `accepted, covers until ${d.expiresOn}` : 'accepted',
    };
  };
  return [
    {
      item: 'Number plate',
      done: f.details.bikePlate !== null,
      detail: f.details.bikePlate ?? 'not given',
    },
    ...RIDER_DOCUMENTS.map(doc),
  ];
}

/** Why a rider cannot go to `to` now, or undefined. Every step needs a reason (logged). */
export function riderStepProblem(
  f: RiderFacts,
  to: RiderStatus,
  reason: string,
  now: number,
): string | undefined {
  if (!NEXT[f.status].includes(to)) return `cannot go from ${f.status} to ${to}`;
  const r = reason.trim();
  if (r.length < 5 || r.length > 300 || CONTROL.test(r)) return 'say why (5 to 300 letters)';
  if (to === 'approved') {
    const missing = approvalChecklist(f, now).filter((c) => !c.done);
    if (missing.length)
      return `not ready: ${missing.map((c) => `${c.item} ${c.detail}`).join('; ')}`;
  }
  if (to === 'active' && !f.screenFitted) return 'fit a screen to his bike first (Screens)';
  if (to === 'left' && f.screenFitted) return 'take his screen off first (Screens)';
  return undefined;
}
