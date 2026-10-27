// Calls the RECALL API (P4.1). The session token goes as a bearer header; errors come back with the
// server's reason code (`why`) so the app can word them in the rider's language.

/** Where the API is: set at build time (EXPO_PUBLIC_API_URL); a laptop's API by default. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8080').replace(
  /\/+$/,
  '',
);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's reason code ("wrong-code", …); "offline" when the API could not be reached. */
    readonly why: string | undefined,
    readonly n: number | undefined,
  ) {
    super(message);
  }
}

export async function call<T>(
  path: string,
  opts: { readonly body?: object; readonly token?: string | null; readonly base?: string } = {},
): Promise<T> {
  const abort = new AbortController();
  // Weak signal: give up after 20 seconds and say so, rather than spin for ever.
  const timer = setTimeout(() => abort.abort(), 20_000);
  let r: Response;
  try {
    r = await fetch(`${opts.base ?? API_URL}${path}`, {
      method: opts.body ? 'POST' : 'GET',
      headers: {
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: abort.signal,
    });
  } catch {
    throw new ApiError(0, 'Could not reach RECALL', 'offline', undefined);
  } finally {
    clearTimeout(timer);
  }
  let x: unknown;
  try {
    x = await r.json();
  } catch {
    x = undefined;
  }
  if (!r.ok) {
    const e = (x ?? {}) as { error?: unknown; why?: unknown; n?: unknown };
    throw new ApiError(
      r.status,
      typeof e.error === 'string' ? e.error : 'Something went wrong',
      typeof e.why === 'string' ? e.why : undefined,
      typeof e.n === 'number' ? e.n : undefined,
    );
  }
  return x as T;
}

export interface Me {
  readonly phone: string;
  readonly shown: string;
  readonly riderId: string | null;
  readonly name: string | null;
  readonly status: string | null;
}
