// P3.9.2: the ad review queue. Ad review (and Sales, to see) look; an Ad review admin decides.
//   GET  /reviews                    ads waiting (soonest needed first), bookings waiting for a
//                                    short-notice approval, the latest decisions
//   POST /reviews/ad/<adId>          { decision: 'approved' | 'rejected', reason?, checklist }
//   POST /reviews/booking/<id>       { reason }: approve a booking's ads on short notice
import { approveOnShortNotice, Refusal, reviewAd, reviewQueue, type Ad } from '@recall/db';
import { can, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'ad-review', change: false }) || can(a, { area: 'sales', change: false });
const reviewer = { area: 'ad-review', change: true } as const;
/** Preview links work this long (seconds). */
const PREVIEW_SECONDS = 15 * 60;

async function refusedAs400<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refusal) throw new HttpError(400, e.message);
    throw e;
  }
}

export async function handleReviews(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/reviews' && !path.startsWith('/reviews/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  if (method === 'GET') {
    if (path !== '/reviews') throw new HttpError(404, 'Not found');
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'File storage is not set up');
    const shown = <T extends Ad>(a: T) => ({
      ...a,
      preview: store.readLink(a.fileKey, now + PREVIEW_SECONDS),
    });
    const q = await reviewQueue(pool);
    send(res, 200, {
      at: now,
      waiting: q.waiting.map(shown),
      shortNotice: q.shortNotice,
      recent: q.recent.map(shown),
    });
    return true;
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs, reviewer);
  const who = `${me.name} (${me.id})`.slice(0, 120);
  const ad = /^\/reviews\/ad\/(AD-[0-9A-F]{10})$/.exec(path);
  const booking = /^\/reviews\/booking\/(BK-[A-Za-z0-9-]{1,36})$/.exec(path);
  const b = await jsonBody(req);
  if (ad) {
    const decision = b.decision;
    if (decision !== 'approved' && decision !== 'rejected')
      throw new HttpError(400, 'decision must be approved or rejected');
    const reason = b.reason === undefined || b.reason === null ? null : str(b, 'reason', 500);
    const raw = b.checklist ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw))
      throw new HttpError(400, 'checklist must be ticks by rule');
    const checklist = Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, v === true]),
    );
    const out = await refusedAs400(() =>
      reviewAd(pool, { adId: ad[1] ?? '', decision, reason, checklist, by: who }, now),
    );
    send(res, 200, out);
    return true;
  }
  if (booking) {
    const reason = str(b, 'reason', 500);
    await refusedAs400(() => approveOnShortNotice(pool, booking[1] ?? '', who, reason, now));
    send(res, 200, { bookingId: booking[1], state: 'ads-approved' });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
