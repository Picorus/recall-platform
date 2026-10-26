// Passes /api/... to the API service, read at run time (API_URL). The browser only ever talks to
// this site, so the session cookie stays here (SameSite=Strict). Only the headers the API needs go
// through; the API checks everything itself.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const PASS_UP = ['content-type', 'cookie', 'origin', 'user-agent', 'x-forwarded-for'];
const PASS_DOWN = ['content-type', 'cache-control'];
const MAX_BODY = 16 * 1024;

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
  const body = req.method === 'POST' ? await req.arrayBuffer() : undefined;
  if (body && body.byteLength > MAX_BODY)
    return Response.json({ error: 'Too large' }, { status: 413 });
  let r: Response;
  try {
    r = await fetch(`${api}/${path.join('/')}`, {
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
