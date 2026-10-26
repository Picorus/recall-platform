// Passes /api/... to the API service, read at run time (API_URL). The browser only ever talks to
// this site, so the session cookie stays here (SameSite=Strict). Only the headers the API needs go
// through; the API checks everything itself.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const PASS_UP = ['content-type', 'cookie', 'origin', 'user-agent', 'x-forwarded-for'];
const PASS_DOWN = ['content-type', 'cache-control'];
const MAX_BODY = 16 * 1024;

/** The request body, read up to 16 KB (never more is held), or null when it is larger. */
async function smallBody(req: NextRequest): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  const out = new Uint8Array(new ArrayBuffer(MAX_BODY));
  let size = 0;
  const reader = req.body?.getReader();
  if (!reader) return out.subarray(0, 0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out.subarray(0, size);
    if (size + value.length > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    out.set(value, size);
    size += value.length;
  }
}

async function pass(req: NextRequest, path: string[]): Promise<Response> {
  const api = process.env.API_URL || 'http://127.0.0.1:8080';
  // Only plain path parts: nothing can point the request elsewhere.
  if (!path.every((p) => /^[A-Za-z0-9_-]+$/.test(p)))
    return Response.json({ error: 'Not found' }, { status: 404 });
  const headers = new Headers();
  for (const h of PASS_UP) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // A plain query (?area=hyd-madhapur&from=2027-08-23) goes through; anything else is refused.
  const query = req.nextUrl.search;
  if (query.length > 300 || !/^(\?[A-Za-z0-9_.:=&-]*)?$/.test(query))
    return Response.json({ error: 'Not found' }, { status: 404 });
  const body = req.method === 'POST' ? await smallBody(req) : undefined;
  if (body === null) return Response.json({ error: 'Too large' }, { status: 413 });
  let r: Response;
  try {
    r = await fetch(`${api}/${path.join('/')}${query}`, {
      method: req.method,
      headers,
      body: body ?? null,
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json({ error: 'The server did not answer. Try again.' }, { status: 502 });
  }
  const out = new Headers();
  for (const h of PASS_DOWN) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  for (const c of r.headers.getSetCookie()) out.append('set-cookie', c);
  return new Response(r.body, { status: r.status, headers: out });
}

interface Ctx {
  readonly params: Promise<{ path: string[] }>;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return pass(req, (await ctx.params).path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return pass(req, (await ctx.params).path);
}
