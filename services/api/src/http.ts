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
