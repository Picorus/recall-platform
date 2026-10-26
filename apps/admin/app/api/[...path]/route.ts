// Passes /api/... to the API service, read at run time (API_URL). The browser only ever talks to
// this site, so the session cookie stays here (SameSite=Strict). Only the headers the API needs go
// through; the API checks everything itself.
import type { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const PASS_UP = ['content-type', 'cookie', 'origin', 'user-agent', 'x-forwarded-for'];
const PASS_DOWN = [
  'content-type',
  'cache-control',
  'content-length',
  'x-content-type-options',
  'content-security-policy',
];
const MAX_BODY = 16 * 1024;

/** An upload (an ad, P3.9.1; a rider's document) may carry a file up to 64 MB (the API sets each
 * kind's own limit); every other request at most 16 KB.
 * An upload is passed on as it arrives (this site never holds it), a few at a time. */
const MAX_UPLOAD = 64 * 1024 * 1024;
const MAX_UPLOADS = 2;
let uploading = 0;

/** The request body passed on as it arrives; stopped if it runs past `declared` bytes (then
 * `over()` is true) or ends short of it (a cut-off upload is never passed on as a whole file). */
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
  // A plain query (?area=hyd-madhapur&from=2027-08-23) goes through; anything else is refused. An
  // upload's may also carry an encoded ad name (name=Evening%20offer). It is only ever added after
  // the fixed API address and path, so an encoded character in it cannot change where it goes.
  // File uploads: an ad (P3.9.1) or a rider's document (P3.11.1).
  const upload =
    req.method === 'POST' &&
    ((path.length === 2 && path[0] === 'ads' && path[1] === 'upload') ||
      (path.length === 3 && path[0] === 'riders' && path[2] === 'documents'));
  const query = req.nextUrl.search;
  // A "+" is a space (a name searched for); "%" (any encoded character) only with an upload.
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
    // The API checks it received exactly this many bytes.
    headers.set('x-upload-bytes', String(declared));
    if (uploading >= MAX_UPLOADS)
      return Response.json(
        { error: 'Other uploads are running. Try again in a minute.' },
        { status: 503 },
      );
  }
  const body = req.method === 'POST' && !upload ? await smallBody(req, MAX_BODY) : undefined;
  if (body === null) return Response.json({ error: 'Too large' }, { status: 413 });
  const sent = upload ? cappedStream(req, Number(headers.get('x-upload-bytes'))) : null;
  let r: Response;
  if (upload) uploading += 1;
  try {
    r = await fetch(`${api}/${path.join('/')}${query}`, {
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
    if (upload) uploading -= 1;
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
