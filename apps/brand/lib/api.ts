// Calls the API through this site's /api path (same site: the session cookie goes with it; the
// site passes it to the API's /portal routes only).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** What went wrong, for the page to word itself (e.g. "wrong-code"), and maybe a number. */
    readonly why?: string,
    readonly n?: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, body?: object): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let x: unknown = undefined;
  try {
    x = await r.json();
  } catch {
    // not JSON (the API is down): handled below
  }
  if (!r.ok) {
    const e = (x ?? {}) as { error?: unknown; why?: unknown; n?: unknown };
    throw new ApiError(
      r.status,
      typeof e.error === 'string' ? e.error : 'The server did not answer. Try again.',
      typeof e.why === 'string' ? e.why : undefined,
      typeof e.n === 'number' ? e.n : undefined,
    );
  }
  return x as T;
}

export interface Account {
  readonly brandId: string;
  readonly name: string;
  readonly kind: 'brand' | 'agency';
  readonly role: 'owner' | 'booker';
  /** P5.10: a brand reached through the person's agency. */
  readonly via: { readonly agencyId: string; readonly name: string } | null;
}

export interface Me {
  readonly address: string;
  readonly shown: string;
  readonly accounts: readonly Account[];
}

/** P5.2: a business as its portal shows it. */
export interface Business {
  readonly brandId: string;
  readonly name: string;
  readonly kind: 'brand' | 'agency';
  readonly businessType: string | null;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly stateCode: string | null;
  readonly stateName: string | null;
  readonly address: string | null;
  readonly invoiceEmail: string | null;
  readonly phone: string | null;
  readonly freeWeek: { readonly days: number; readonly bikeHours: number } | null;
}

export interface BusinessForm {
  readonly types: readonly { key: string; label: string }[];
  readonly states: readonly { code: string; name: string }[];
}

export type GstAnswer =
  | {
      readonly status: 'found';
      readonly legalName: string;
      readonly tradeName: string | null;
      readonly stateCode: string;
      readonly stateName: string | null;
      readonly address: string;
    }
  | { readonly status: 'type-it' };

/** P5.3: one campaign on the portal. */
export interface Campaign {
  readonly bookingId: string;
  readonly stage: 'to-pay' | 'scheduled' | 'running' | 'done' | 'cancelled' | 'missed';
  readonly note: string | null;
  readonly trial: boolean;
  readonly areas: readonly string[];
  readonly firstDay: string;
  readonly lastDay: string;
  readonly days: number;
  readonly bikeHours: number;
  readonly playsPromised: number;
  readonly totalPaise: number;
  /** Its final report is ready (P5.7). */
  readonly report: boolean;
}

/** P5.9: Help. */
export interface Help {
  readonly account: Account;
  readonly phones: readonly { label: string; phone: string; whatsapp: boolean }[];
  readonly open: boolean;
  readonly days: readonly number[];
  readonly opens: string;
  readonly closes: string;
  readonly answers: readonly { q: string; a: string }[];
  readonly adRules: readonly string[];
  readonly questions: readonly {
    at: number;
    subject: string;
    state: 'open' | 'waiting' | 'done';
  }[];
}

/** P5.9: Team. */
export interface Team {
  readonly account: Account;
  readonly me: string;
  readonly team: readonly {
    address: string;
    shown: string;
    role: 'owner' | 'booker';
    since: number;
  }[];
  readonly max: number;
  readonly agency: string | null;
}

/** P5.10: an agency's monthly statement. */
export interface Statement {
  readonly account: Account;
  readonly name: string;
  readonly month: string;
  readonly openingPaise: number;
  readonly cuts: readonly {
    bookingId: string;
    cutPaise: number;
    gstPaise: number;
    tdsPaise: number;
    netPaise: number;
  }[];
  readonly payments: readonly { at: number; amountPaise: number; reference: string }[];
  readonly invoices: readonly {
    invoiceNo: string;
    invoiceDate: string;
    taxablePaise: number;
    gstPaise: number;
  }[];
  readonly closingPaise: number;
}

/** P5.8: a tax invoice or credit note. */
export interface TaxDocument {
  readonly docNo: string;
  readonly kind: 'invoice' | 'credit-note';
  readonly issuedAt: number;
  readonly againstDoc: string | null;
  readonly bookingId: string;
  readonly gstin: string | null;
  readonly gstinHeld: boolean;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly totalPaise: number;
}

export interface Invoices {
  readonly account: Account;
  readonly years: readonly string[];
  readonly fy: string;
  readonly documents: readonly TaxDocument[];
  readonly truncated: boolean;
}

/** P5.7: a campaign's final report. */
export interface Report {
  readonly account: Account;
  readonly bookingId: string;
  readonly period: string;
  readonly summary: readonly string[];
  /** The report as a whole page, the same one the "Done" message links to. */
  readonly html: string;
}

export interface Campaigns {
  readonly at: number;
  readonly account: Account;
  readonly campaigns: readonly Campaign[];
}

/** P5.4: what a brand picks. */
export interface Plan {
  readonly areaIds: readonly string[];
  readonly hours: readonly number[];
  readonly weekdays: readonly number[];
  readonly startDate: string;
  readonly weeks: number;
  readonly bikes: number;
  readonly repeatMonths: number;
}

export interface BookForm {
  readonly areas: readonly {
    areaId: string;
    name: string;
    ring: readonly (readonly [number, number])[];
    centre: readonly [number, number];
  }[];
  readonly hours: readonly {
    hour: number;
    label: string;
    band: string;
    paisePerBikeHour: number;
  }[];
  readonly picks: readonly { key: string; label: string; hours: readonly number[] }[];
  readonly earliestStart: string;
  readonly leadDays: number;
  readonly minBikes: number;
  readonly maxBikes: number;
  readonly maxWeeks: number;
  readonly repeatOffersBp: Readonly<Record<string, number>>;
  readonly minBookingPaise: number;
  readonly adsDueDays: number;
}

export interface PlanPrice {
  readonly price: {
    lines: number;
    days: number;
    bikeHours: number;
    plays: number;
    listPaise: number;
    discountPaise: number;
    subtotalPaise: number;
    gstPaise: number;
    totalPaise: number;
    firstDay: string;
    lastDay: string;
  } | null;
  readonly problems: readonly string[];
}

/** P5.5: one of a brand's ads, as the portal shows it. */
export interface Ad {
  readonly adId: string;
  readonly name: string;
  readonly kind: 'png' | 'jpeg' | 'webp' | 'mp4' | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly checks: readonly { check: string; outcome: 'pass' | 'warn' | 'fail'; detail: string }[];
  readonly outcome: 'pass' | 'warn' | 'fail';
  readonly review: { decision: 'approved' | 'rejected'; reason: string | null } | null;
  readonly uploadedAt: number;
}

/** Sends a file as the request body (an ad upload); the same errors as `api`. */
export async function upload<T>(path: string, file: File): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let x: unknown = undefined;
  try {
    x = await r.json();
  } catch {
    // not JSON: handled below
  }
  if (!r.ok) {
    const e = (x ?? {}) as { error?: unknown };
    throw new ApiError(
      r.status,
      typeof e.error === 'string' ? e.error : 'The upload did not go through. Try again.',
    );
  }
  return x as T;
}
