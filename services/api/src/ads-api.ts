// P3.9.1: ads. Sales, Ad review and Support look; a Sales admin uploads an ad for a brand (the
// file's own bytes are read and checked) and chooses which ads a booking runs.
//   POST /ads/upload?brand=<id>&name=<name>   the file as the body (up to the largest ad allowed)
//   GET  /ads?brand=<id>                      a brand's ads with their checks and a preview link
//   GET  /ads/booking/<bookingId>             the ads a booking runs
//   POST /ads/booking/<bookingId>             { adIds }
// And, on a laptop only (the fake store), the files themselves through signed links:
//   GET  /files/<key>?until=<s>&sig=<hex>
import type { FileStore } from '@recall/adapters';
import { can, MAX_AD_UPLOAD_BYTES, type StaffAccess } from '@recall/domain';
import { bookingAds, brandAds, Refusal, setBookingAds, uploadAd, type Ad } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) ||
  can(a, { area: 'ad-review', change: false }) ||
  can(a, { area: 'support', change: false });
const sales = { area: 'sales', change: true } as const;
/** Preview links work this long (seconds). */
const PREVIEW_SECONDS = 15 * 60;

async function refusedAs400<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refusal || e instanceof RangeError) throw new HttpError(400, e.message);
    throw e;
  }
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

export async function handleAds(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  const q = new URLSearchParams(query);
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  const store: FileStore | undefined = cfg.files;

  const file = /^\/files\/([0-9a-f]{64})$/.exec(path);
  if (file) {
    // Only the laptop's fake store is served here; a real store serves its own signed links.
    const fake = store as
      | (FileStore & { checkLink?: (k: string, u: number, s: string, n: number) => boolean })
      | undefined;
    if (method !== 'GET' || !fake?.checkLink) throw new HttpError(404, 'Not found');
    const key = file[1] ?? '';
    if (!fake.checkLink(key, Number(q.get('until')), q.get('sig') ?? '', now))
      throw new HttpError(403, 'This link is not valid any more');
    const f = await fake.get(key);
    if (!f) throw new HttpError(404, 'Not found');
    // Kept by the browser no longer than the link lasts; never run as a page if opened directly.
    const left = Math.max(0, Math.min(600, Number(q.get('until')) - now));
    res.writeHead(200, {
      'content-type': f.contentType,
      'content-length': f.data.length,
      'cache-control': `private, max-age=${left}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': 'sandbox',
    });
    res.end(Buffer.from(f.data));
    return true;
  }
  if (path !== '/ads' && !path.startsWith('/ads/')) return false;
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');
  if (!store) throw new HttpError(503, 'File storage is not set up');
  const shown = (a: Ad) => ({ ...a, preview: store.readLink(a.fileKey, now + PREVIEW_SECONDS) });
  const booking = /^\/ads\/booking\/(BK-[A-Za-z0-9-]{1,36})$/.exec(path);

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/ads') {
      const brandId = q.get('brand') ?? '';
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(brandId)) throw new HttpError(400, 'Which brand?');
      send(res, 200, { ads: (await brandAds(pool, brandId)).map(shown) });
      return true;
    }
    if (booking) {
      send(res, 200, { ads: (await bookingAds(pool, booking[1] ?? '')).map(shown) });
      return true;
    }
    throw new HttpError(404, 'Not found');
  }

  const me = await staffFor(pool, cfg, req, nowMs, sales);
  const who = `${me.name} (${me.id})`.slice(0, 120);
  if (path === '/ads/upload') {
    const brandId = q.get('brand') ?? '';
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(brandId)) throw new HttpError(400, 'Which brand?');
    if (uploading >= MAX_UPLOADS)
      throw new HttpError(503, 'Other uploads are running. Try again in a minute.');
    uploading += 1;
    try {
      const data = await bodyBytes(req, MAX_AD_UPLOAD_BYTES, UPLOAD_SECONDS);
      const ad = await refusedAs400(() =>
        uploadAd(pool, store, { brandId, name: q.get('name') ?? '', data, by: who }, now),
      );
      send(res, 200, { ad: shown(ad) });
    } finally {
      uploading -= 1;
    }
    return true;
  }
  if (booking) {
    const b = await jsonBody(req);
    if (!Array.isArray(b.adIds) || !b.adIds.every((x) => typeof x === 'string'))
      throw new HttpError(400, 'adIds must be a list of ad ids');
    const adIds = b.adIds as string[];
    const version = await refusedAs400(() =>
      setBookingAds(pool, booking[1] ?? '', adIds, who, now),
    );
    send(res, 200, { version });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
