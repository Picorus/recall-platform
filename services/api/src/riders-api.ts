// P3.11.1: riders. Operations and Support look; an Operations admin adds and changes riders, moves
// their steps and looks at their documents; Operations and Support admins add notes.
//   GET  /riders?status=&q=                          riders, newest first
//   POST /riders                                     { name, phone, bikePlate, rides, apps, reason }
//   GET  /riders/<id>                                one rider's page (documents with preview links)
//   POST /riders/<id>/details                        { name, phone, bikePlate, rides, apps, reason }
//   POST /riders/<id>/step                           { to, reason }
//   POST /riders/<id>/documents?kind=photo|rc|insurance   the file as the body (at most 10 MB)
//   POST /riders/<id>/documents/<docId>/review       { decision, reason, expiresOn? }
//   POST /riders/<id>/notes                          { note }
//   POST /riders/<id>/identity                       start his identity check (KYC): a link for him
//   POST /riders/<id>/agreement                      send him the rider agreement to sign
//   POST /riders/<id>/bank                           { kind: 'bank', accountNumber, ifsc, name }
//                                                    or { kind: 'upi', vpa, name }: a ₹1 check
//   POST /riders/<id>/checks                         ask the providers about checks still waiting
// Personal documents: previews only for those who look at them (Operations admins); read-only
// members see phones masked.
import {
  addRiderNote,
  checkRiderBank,
  createRider,
  refreshRiderChecks,
  sendAgreement,
  startIdentityCheck,
  Refusal,
  reviewRiderDocument,
  reviseRider,
  riderList,
  riderPage,
  stepRider,
  uploadRiderDocument,
} from '@recall/db';
import {
  can,
  MAX_DOCUMENT_BYTES,
  RIDER_DOCUMENTS,
  phoneOf,
  plateOf,
  RIDER_STATUSES,
  type RiderApp,
  type RiderDetails,
  type RiderStatus,
  type StaffAccess,
} from '@recall/domain';
import type { PayoutDestination } from '@recall/adapters';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str, withUpload } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

/** "+91 ••••••2345": enough to recognise on a call, not to find or call him. */
const maskPhone = (p: string) => `+91 ••••••${p.slice(-4)}`;

async function riderExists(pool: Pool, riderId: string): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM riders WHERE rider_id = $1', [riderId]);
  return (r.rowCount ?? 0) > 0;
}

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'operations', change: false }) || can(a, { area: 'support', change: false });
const operations = { area: 'operations', change: true } as const;
const mayNote = (a: StaffAccess) =>
  can(a, { area: 'operations', change: true }) || can(a, { area: 'support', change: true });
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

/** Details from a request, phone and plate put in one form (left as sent if they are not one). */
function detailsOf(b: Record<string, unknown>): RiderDetails {
  const phone = str(b, 'phone', 30);
  const plate = b.bikePlate === null || b.bikePlate === '' ? null : str(b, 'bikePlate', 20);
  if (!Array.isArray(b.apps) || !b.apps.every((x) => typeof x === 'string') || b.apps.length > 12)
    throw new HttpError(400, 'apps must be a list');
  return {
    name: str(b, 'name', 80),
    phone: phoneOf(phone) ?? phone,
    bikePlate: plate === null ? null : (plateOf(plate) ?? plate),
    rides: str(b, 'rides', 120),
    apps: b.apps as RiderApp[],
  };
}

export async function handleRiders(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/riders' && !path.startsWith('/riders/')) return false;
  const q = new URLSearchParams(query);
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  const m =
    /^\/riders\/(RD-\d{6})(?:\/(details|step|notes|documents|identity|agreement|bank|checks)(?:\/(DOC-[0-9A-F]{10})\/review)?)?$/.exec(
      path,
    );
  if (path !== '/riders' && !m) throw new HttpError(404, 'Not found');
  const riderId = m?.[1] ?? '';
  const part = m?.[2];
  const docId = m?.[3];

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/riders') {
      const status = q.get('status');
      if (status !== null && !(RIDER_STATUSES as readonly string[]).includes(status))
        throw new HttpError(400, 'Which status?');
      const masked = me.access.role === 'read-only';
      // Read-only members search by name, id or plate, never by phone digits (they see them masked).
      const raw = (q.get('q') ?? '').slice(0, 60);
      const text = masked ? raw.replace(/\d{4,}/g, '').trim() : raw;
      const riders = await riderList(pool, {
        ...(status ? { status: status as RiderStatus } : {}),
        q: text,
      });
      send(res, 200, {
        riders: masked ? riders.map((r) => ({ ...r, phone: maskPhone(r.phone) })) : riders,
      });
      return true;
    }
    if (part) throw new HttpError(404, 'Not found');
    const reviewer = can(me.access, operations);
    // Checks still waiting: those who act ask the providers first (a failure leaves them waiting).
    if (cfg.riderChecks && reviewer)
      await refreshRiderChecks(pool, cfg.riderChecks, riderId, now).catch(() => 0);
    const page = await riderPage(pool, riderId, now);
    if (!page) throw new HttpError(404, `No rider ${riderId}`);
    const store = cfg.files;
    send(res, 200, {
      at: now,
      ...page,
      // A check's link works for whoever holds it: only for those who send it to him.
      checks: page.checks.map((c) => ({ ...c, link: reviewer ? c.link : null })),
      rider:
        me.access.role === 'read-only'
          ? { ...page.rider, phone: maskPhone(page.rider.phone) }
          : page.rider,
      // The file's fingerprint never leaves; a preview link only for those who look at them.
      documents: page.documents.map(({ fileKey, ...d }) => ({
        ...d,
        preview: store && reviewer ? store.readLink(fileKey, now + PREVIEW_SECONDS) : null,
      })),
    });
    return true;
  }

  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');

  if (part === 'notes') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayNote(me.access)) throw new HttpError(403, 'Your access does not cover this');
    const b = await jsonBody(req);
    await refusedAs400(() =>
      addRiderNote(pool, riderId, str(b, 'note', 2000), `${me.name} (${me.id})`.slice(0, 120), now),
    );
    send(res, 200, { ok: true });
    return true;
  }

  const me = await staffFor(pool, cfg, req, nowMs, operations);
  const who = `${me.name} (${me.id})`.slice(0, 120);
  if (path === '/riders') {
    const b = await jsonBody(req);
    const id = await refusedAs400(() =>
      createRider(
        pool,
        { details: detailsOf(b), channel: 'admin', by: who, reason: str(b, 'reason', 300) },
        now,
      ),
    );
    send(res, 200, { riderId: id });
    return true;
  }
  if (part === 'details') {
    const b = await jsonBody(req);
    const version = await refusedAs400(() =>
      reviseRider(pool, riderId, detailsOf(b), who, str(b, 'reason', 300), now),
    );
    send(res, 200, { version });
    return true;
  }
  if (part === 'step') {
    const b = await jsonBody(req);
    const to = b.to;
    if (typeof to !== 'string' || !(RIDER_STATUSES as readonly string[]).includes(to))
      throw new HttpError(400, 'Which step?');
    // Checks still waiting may have been answered: ask before the approval list is read.
    if (to === 'approved' && cfg.riderChecks)
      await refreshRiderChecks(pool, cfg.riderChecks, riderId, now).catch(() => 0);
    await refusedAs400(() =>
      stepRider(pool, riderId, to as RiderStatus, who, str(b, 'reason', 300), now),
    );
    send(res, 200, { status: to });
    return true;
  }
  if (part === 'documents' && !docId) {
    const store = cfg.files;
    if (!store) throw new HttpError(503, 'File storage is not set up');
    const kind = q.get('kind') ?? '';
    // Before a byte of the file is read: which document, and whose.
    if (!(RIDER_DOCUMENTS as readonly string[]).includes(kind))
      throw new HttpError(400, 'Which document? (photo, rc or insurance)');
    if (!(await riderExists(pool, riderId))) throw new HttpError(404, `No rider ${riderId}`);
    await withUpload(req, 'documents', MAX_DOCUMENT_BYTES, async (data) => {
      const { fileKey, ...doc } = await refusedAs400(() =>
        uploadRiderDocument(pool, store, { riderId, kind, data, by: who }, now),
      );
      send(res, 200, {
        document: { ...doc, preview: store.readLink(fileKey, now + PREVIEW_SECONDS) },
      });
    });
    return true;
  }
  if (part === 'identity' || part === 'agreement' || part === 'bank' || part === 'checks') {
    const checks = cfg.riderChecks;
    if (!checks) throw new HttpError(503, 'Rider checks are not set up yet');
    if (part === 'identity') {
      send(
        res,
        200,
        await refusedAs400(() => startIdentityCheck(pool, checks.kyc, riderId, who, now)),
      );
      return true;
    }
    if (part === 'agreement') {
      send(
        res,
        200,
        await refusedAs400(() => sendAgreement(pool, checks.esign, riderId, who, now)),
      );
      return true;
    }
    if (part === 'checks') {
      send(res, 200, { answered: await refreshRiderChecks(pool, checks, riderId, now) });
      return true;
    }
    const b = await jsonBody(req);
    const name = str(b, 'name', 120).trim();
    const to: PayoutDestination =
      b.kind === 'upi'
        ? { kind: 'upi', vpa: str(b, 'vpa', 256).trim(), name }
        : b.kind === 'bank'
          ? {
              kind: 'bank',
              accountNumber: str(b, 'accountNumber', 30).replace(/[\s-]/g, ''),
              ifsc: str(b, 'ifsc', 20).trim().toUpperCase(),
              name,
            }
          : (() => {
              throw new HttpError(400, 'kind must be bank or upi');
            })();
    send(
      res,
      200,
      await refusedAs400(() =>
        checkRiderBank(
          pool,
          checks.bank,
          riderId,
          to,
          { who, superAdmin: me.access.role === 'super-admin' },
          now,
        ),
      ),
    );
    return true;
  }
  if (part === 'documents' && docId) {
    const b = await jsonBody(req);
    const decision = b.decision;
    if (decision !== 'accepted' && decision !== 'rejected')
      throw new HttpError(400, 'decision must be accepted or rejected');
    const expiresOn =
      b.expiresOn === undefined || b.expiresOn === null ? null : str(b, 'expiresOn', 10);
    await refusedAs400(() =>
      reviewRiderDocument(
        pool,
        { riderId, docId, decision, reason: str(b, 'reason', 300), expiresOn, by: who },
        now,
      ),
    );
    send(res, 200, { decision });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
