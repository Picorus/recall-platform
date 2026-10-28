// P7.8: the POC package for staff (the "POC" page, Sales). Sales and Finance (and super admins) look;
// a Sales admin (or a super admin) adds a brand with its commitment and ads, changes its ads, and
// sends a month's payment link or asks the provider about it.
//   GET  /poc                                   every POC brand side by side: months, payments,
//                                               plays this month and today; bikes fitted vs the most
//   GET  /poc/report?brand=<id>&month=YYYY-MM   a brand's month: plays, bikes, hours, streets, people
//   POST /poc/brands        { brandId, firstMonth, months, adIds, reason }   a brand joins
//   POST /poc/brands/ads    { brandId, adIds }                              its ads (2 to 5)
//   POST /poc/pay           { ref }   a payment link for "poc/<brand>/<YYYY-MM>" (the same one again)
//   POST /poc/check         { ref }   asks the payment provider now
import {
  addPocBrand,
  checkPocPayment,
  pocDesk,
  pocPhaseAt,
  pocReport,
  Refusal,
  sendPocForPayment,
  setPocAds,
} from '@recall/db';
import { can, parsePocRef, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) || can(a, { area: 'finance', change: false });
const sales = { area: 'sales', change: true } as const;

async function refused<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refusal || e instanceof RangeError)
      throw new HttpError(
        400,
        e.message,
        e instanceof Refusal && e.why
          ? { code: e.why.code, ...(e.why.n !== undefined ? { n: e.why.n } : {}) }
          : undefined,
      );
    throw e;
  }
}

const adList = (x: unknown): string[] => {
  if (!Array.isArray(x) || x.length > 20 || !x.every((a) => typeof a === 'string'))
    throw new HttpError(400, 'adIds: a list of ad ids');
  return x as string[];
};

export async function handlePoc(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/poc' && !path.startsWith('/poc/')) return false;
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/poc') {
      send(res, 200, {
        ...(await pocDesk(pool, now)),
        phase: await pocPhaseAt(pool, now),
        canChange: can(me.access, sales),
      });
      return true;
    }
    if (path === '/poc/report') {
      const q = new URLSearchParams(query);
      const r = await pocReport(
        pool,
        q.get('brand') ?? '',
        q.get('month') ?? '',
        cfg.maps ?? cfg.reports?.maps,
      );
      if (!r) throw new HttpError(404, 'No such POC month');
      send(res, 200, r);
      return true;
    }
    throw new HttpError(404, 'Not found');
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs, sales);
  const who = `${me.name} (${me.id})`.slice(0, 120);
  const b = await jsonBody(req);

  if (path === '/poc/brands') {
    const months = b.months;
    if (typeof months !== 'number') throw new HttpError(400, 'months: a whole number');
    const refs = await refused(() =>
      addPocBrand(
        pool,
        {
          brandId: str(b, 'brandId', 64),
          firstMonth: str(b, 'firstMonth', 7),
          months,
          adIds: adList(b.adIds),
          reason: str(b, 'reason', 300),
        },
        who,
        now,
      ),
    );
    send(res, 200, { refs });
    return true;
  }
  if (path === '/poc/brands/ads') {
    const version = await refused(() =>
      setPocAds(pool, str(b, 'brandId', 64), adList(b.adIds), who, now),
    );
    send(res, 200, { version });
    return true;
  }
  if (path === '/poc/pay' || path === '/poc/check') {
    const payments = cfg.payments;
    if (!payments) throw new HttpError(503, 'Payments are not set up');
    const ref = str(b, 'ref', 120);
    if (!parsePocRef(ref)) throw new HttpError(400, 'ref: like poc/<brand>/<YYYY-MM>');
    if (path === '/poc/pay') {
      send(res, 200, await refused(() => sendPocForPayment(pool, payments, ref, who, now)));
      return true;
    }
    send(res, 200, { outcome: await refused(() => checkPocPayment(pool, payments, ref, now)) });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
