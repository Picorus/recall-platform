import type { Area, Role } from './staff';

// Calls the API through this site's /api path (same site: the session cookie goes with it).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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
    const msg = (x as { error?: unknown } | undefined)?.error;
    throw new ApiError(
      r.status,
      typeof msg === 'string' ? msg : 'The server did not answer. Try again.',
    );
  }
  return x as T;
}

export interface Member {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly areas: readonly Area[];
  readonly active: boolean;
}
