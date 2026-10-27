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
