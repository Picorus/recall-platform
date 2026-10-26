// Small HTTP helpers for the API (Node's own server; no framework to keep up to date).
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 16 * 1024;

/** The request's JSON object body (at most 16 KB, sent as application/json). */
export async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Too large');
    chunks.push(chunk as Buffer);
  }
  let x: unknown;
  try {
    x = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Not JSON');
  }
  if (typeof x !== 'object' || x === null || Array.isArray(x))
    throw new HttpError(400, 'Send a JSON object');
  return x as Record<string, unknown>;
}

export function str(x: Record<string, unknown>, key: string, max = 300): string {
  const v = x[key];
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `${key} is missing`);
  // No control characters (the database refuses a NUL; none belongs in a name, email or password).
  for (const ch of v) {
    const n = ch.charCodeAt(0);
    if (n < 32 || n === 127) throw new HttpError(400, `${key} has a character that is not allowed`);
  }
  return v;
}

export function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(text);
}

export function cookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

/** Uploads at once (each holds a file of up to 64 MB in memory), and how long one may take. */
const MAX_UPLOADS = 2;
const UPLOAD_SECONDS = 180;
let uploading = 0;

/** The body as bytes, refused past `max` (read as it arrives, never more held), when it takes
 * longer than `seconds` (a slow sender cannot hold the memory), or when it is not exactly the
 * size declared (the admin site passes the browser's as x-upload-bytes): a cut-off upload is
 * never kept as a whole file. */
async function bodyBytes(req: IncomingMessage, max: number, seconds: number): Promise<Buffer> {
  const declared = Number(req.headers['x-upload-bytes'] ?? req.headers['content-length'] ?? NaN);
  if (!Number.isSafeInteger(declared) || declared < 0)
    throw new HttpError(411, 'Send the file with its size');
  if (declared > max) throw new HttpError(413, 'The file is too large');
  const late = setTimeout(
    () => req.destroy(new HttpError(408, 'The upload took too long. Try again.')),
    seconds * 1000,
  );
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw new HttpError(413, 'The file is too large');
      chunks.push(c as Buffer);
    }
    if (size !== declared) throw new HttpError(400, 'The upload was cut off. Try again.');
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(late);
  }
}

/**
 * A file upload (ads, riders' documents): at most MAX_UPLOADS at once across the API, each read
 * whole (see bodyBytes) and handed to `use`.
 */
export async function withUpload(
  req: IncomingMessage,
  max: number,
  use: (data: Buffer) => Promise<void>,
): Promise<void> {
  if (uploading >= MAX_UPLOADS)
    throw new HttpError(503, 'Other uploads are running. Try again in a minute.');
  uploading += 1;
  try {
    await use(await bodyBytes(req, max, UPLOAD_SECONDS));
  } finally {
    uploading -= 1;
  }
}
