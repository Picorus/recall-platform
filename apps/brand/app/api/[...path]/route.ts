// Passes /api/... to the API service's /portal/... routes, read at run time (API_URL). Only the
// portal's routes: whatever path is asked for, it goes under /portal, so a page here can never reach
// a staff route. The browser only ever talks to this site, so the session cookie stays here
// (SameSite=Strict). Only the headers the API needs go through; the API checks everything itself.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const PASS_UP = ['content-type', 'cookie', 'origin', 'user-agent', 'x-forwarded-for'];
const PASS_DOWN = [
  'content-type',
  'cache-control',
  'content-length',
  'x-content-type-options',
  'content-security-policy',
  'content-disposition',
];
const MAX_BODY = 16 * 1024;

/** An ad upload (P5.5) may carry a file up to 64 MB (the API sets the real limit); it is passed on
 * as it arrives (this site never holds it): one at a time for each signed-in browser, a few at once
 * for the whole site (one slow sender never holds up everyone). */
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_UPLOADS = 8;
const uploading = new Set<string>();

/** The request body passed on as it arrives; stopped if it runs past `declared` bytes or ends
 * short of it (a cut-off upload is never passed on as a whole file). */
function cappedStream(req: NextRequest, declared: number) {
  let size = 0;
  const stream = req.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        size += chunk.length;
        if (size > declared) out.error(new Error('too large'));
        else out.enqueue(chunk);
      },
      flush(out) {
        if (size !== declared) out.error(new Error('cut off'));
      },
    }),
  );
  return { stream: stream ?? null, over: () => size > declared, short: () => size < declared };
}

/** The request body, read up to `max` bytes (never more is held), or null when it is larger. */
async function smallBody(req: NextRequest, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  const out = new Uint8Array(new ArrayBuffer(size));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
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
  // File uploads: an ad, or the brand's logo (P5.5).
  const upload =
    req.method === 'POST' &&
    ((path.length === 2 && path[0] === 'ads' && path[1] === 'upload') ||
      (path.length === 1 && path[0] === 'logo'));
  // A plain query (?month=2027-08) goes through; anything else is refused. An upload's may also
  // carry an encoded ad name (name=Diwali%20offer), only ever after the fixed API address and path.
  const query = req.nextUrl.search;
  const plain = upload ? /^(\?[A-Za-z0-9_.:=&%+-]*)?$/ : /^(\?[A-Za-z0-9_.:=&+-]*)?$/;
  if (query.length > 300 || !plain.test(query))
    return Response.json({ error: 'Not found' }, { status: 404 });
  if (upload) {
    // Not signed in: refused before a byte of the file is read (the API checks who it is).
    if (!req.headers.get('cookie'))
      return Response.json({ error: 'Please sign in' }, { status: 401 });
    const declared = Number(req.headers.get('content-length') ?? NaN);
    if (!Number.isSafeInteger(declared) || declared < 0)
      return Response.json({ error: 'Send the file with its size' }, { status: 411 });
    if (declared > MAX_UPLOAD) return Response.json({ error: 'Too large' }, { status: 413 });
    headers.set('x-upload-bytes', String(declared));
    if (uploading.has(req.headers.get('cookie') ?? ''))
      return Response.json(
        { error: 'Your last upload is still going: wait for it to finish' },
        { status: 429 },
      );
    if (uploading.size >= MAX_UPLOADS)
      return Response.json(
        { error: 'Other uploads are running. Try again in a minute.' },
        { status: 503 },
      );
  }
  const body = req.method === 'POST' && !upload ? await smallBody(req, MAX_BODY) : undefined;
  if (body === null) return Response.json({ error: 'Too large' }, { status: 413 });
  const sent = upload ? cappedStream(req, Number(headers.get('x-upload-bytes'))) : null;
  let r: Response;
  const who = req.headers.get('cookie') ?? '';
  if (upload) uploading.add(who);
  try {
    r = await fetch(`${api}/portal/${path.join('/')}${query}`, {
      method: req.method,
      headers,
      body: sent ? sent.stream : (body ?? null),
      // A stream is sent as it arrives (Node's fetch needs this said).
      ...(upload ? { duplex: 'half' } : {}),
      redirect: 'manual',
      cache: 'no-store',
    } as RequestInit);
  } catch {
    if (sent?.over()) return Response.json({ error: 'Too large' }, { status: 413 });
    if (sent?.short())
      return Response.json({ error: 'The upload was cut off. Try again.' }, { status: 400 });
    return Response.json({ error: 'The server did not answer. Try again.' }, { status: 502 });
  } finally {
    if (upload) uploading.delete(who);
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
