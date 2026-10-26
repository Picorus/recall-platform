// P3.10: delivery and make-ups. Operations, Sales, Support and Finance look; a super admin decides a
// refund (approve or reject, with why; the money moves through the ledger, decideRefund).
//   GET  /delivery?day=YYYY-MM-DD          a business day's sold lines (default: today, India time)
//   GET  /delivery/booking/<id>            one booking's lines
//   POST /delivery/refund                  { refundId, decision: 'approved' | 'rejected', reason }
import { bookingDelivery, dayDelivery, decideRefund } from '@recall/db';
import { businessDayOf, can, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  (['operations', 'sales', 'support', 'finance'] as const).some((area) =>
    can(a, { area, change: false }),
  );
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function handleDelivery(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/delivery' && !path.startsWith('/delivery/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/delivery') {
      const asked = new URLSearchParams(query).get('day');
      if (asked !== null && (!DAY.test(asked) || Number.isNaN(Date.parse(asked))))
        throw new HttpError(400, 'Which day? (YYYY-MM-DD)');
      // Default: the business day now, or (02:00–08:00) the one that just ended.
      const day =
        asked ??
        businessDayOf(new Date(nowMs)) ??
        businessDayOf(new Date(nowMs - 6 * 3_600_000)) ??
        '';
      send(res, 200, { at: now, day, lines: await dayDelivery(pool, day, now) });
      return true;
    }
    const b = /^\/delivery\/booking\/(BK-[A-Za-z0-9-]{1,36})$/.exec(path);
    if (b) {
      send(res, 200, { at: now, lines: await bookingDelivery(pool, b[1] ?? '', now) });
      return true;
    }
    throw new HttpError(404, 'Not found');
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  if (path !== '/delivery/refund') throw new HttpError(404, 'Not found');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (me.access.role !== 'super-admin')
    throw new HttpError(403, 'Only a super admin decides a refund');
  const b = await jsonBody(req);
  const refundId = str(b, 'refundId', 200);
  const decision = b.decision;
  if (decision !== 'approved' && decision !== 'rejected')
    throw new HttpError(400, 'decision must be approved or rejected');
  const reason = str(b, 'reason', 300).trim();
  if (reason.length < 5) throw new HttpError(400, 'Say why (5 letters or more)');
  try {
    const out = await decideRefund(
      pool,
      refundId,
      decision,
      { id: me.id, role: me.access.role },
      reason,
      now,
    );
    send(res, 200, { decision, ...out });
  } catch (e) {
    // decideRefund refuses in words (no such refund, already decided).
    if (e instanceof Error && /^(No refund|Refund .* was already)/.test(e.message))
      throw new HttpError(400, e.message);
    throw e;
  }
  return true;
}
