// P3.13.1: money as finance sees it (read-only: nothing here moves money). Finance (and a super
// admin) look.
//   GET /money?month=YYYY-MM          where money stands now; the month's payments, tax invoices and
//                                     credit notes, GST summary; provider messages for unknown links
//   GET /money/export?month=YYYY-MM   the month's files for the accountant (CSV text)
// P3.13.2: money owed back to brands (finance admins and a super admin send it):
//   GET  /money/owed-back             what is still owed back, with each try
//   POST /money/owed-back/send        { owedEntry }  through the payment provider (again: retries)
//   POST /money/owed-back/by-hand     { owedEntry, reference, note }  a bank transfer made by hand
import {
  accountantExport,
  gstDocuments,
  gstSummary,
  moneyOwedBack,
  moneyPosition,
  paymentsIn,
  recordMoneyBackByHand,
  Refusal,
  sendMoneyBack,
  unknownPayments,
} from '@recall/db';
import { can, moneyRole } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
/** The India month of a moment, "YYYY-MM". */
const indiaMonthOf = (t: number) => new Date((t + 330 * 60) * 1000).toISOString().slice(0, 7);

export async function handleMoney(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/money' && !path.startsWith('/money/')) return false;
  if (req.method === 'POST' && path.startsWith('/money/owed-back/'))
    return payBack(pool, cfg, req, res, nowMs, path);
  if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'Not allowed');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (!can(me.access, { area: 'finance', change: false }))
    throw new HttpError(403, 'Your access does not cover this');
  const now = Math.floor(nowMs / 1000);
  const asked = new URLSearchParams(query).get('month');
  if (asked !== null && !MONTH.test(asked)) throw new HttpError(400, 'Which month? (YYYY-MM)');
  const month = asked ?? indiaMonthOf(now);
  if (path === '/money') {
    const [position, pays, docs, gst, unknown] = await Promise.all([
      moneyPosition(pool),
      paymentsIn(pool, month),
      gstDocuments(pool, month),
      gstSummary(pool, month),
      unknownPayments(pool),
    ]);
    send(res, 200, {
      at: now,
      month,
      position,
      payments: pays.payments,
      paymentsTruncated: pays.truncated,
      documents: docs.documents,
      documentsTruncated: docs.truncated,
      gst,
      unknownPayments: unknown,
    });
    return true;
  }
  if (path === '/money/owed-back') {
    send(res, 200, {
      at: now,
      items: await moneyOwedBack(pool),
      canPay: ['finance', 'super-admin'].includes(moneyRole(me.access)),
      canSend: cfg.payments !== undefined,
    });
    return true;
  }
  if (path === '/money/export') {
    send(res, 200, { month, files: await accountantExport(pool, month) });
    return true;
  }
  throw new HttpError(404, 'Not found');
}

/** Sends money owed back, or records a bank transfer made by hand (finance admins, super admin). */
async function payBack(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
  path: string,
): Promise<boolean> {
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs);
  const by = { id: me.id, role: moneyRole(me.access) };
  if (by.role !== 'finance' && by.role !== 'super-admin')
    throw new HttpError(403, 'Only finance or a super admin sends money back');
  const now = Math.floor(nowMs / 1000);
  const b = await jsonBody(req);
  const owedEntry = str(b, 'owedEntry', 200);
  if (!/^(refund|to-return):[A-Za-z0-9#/._-]{1,180}$/.test(owedEntry))
    throw new HttpError(400, 'Which amount owed back?');
  const refused = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      if (e.message.startsWith('Nothing owed back')) throw new HttpError(404, e.message);
      if (/already|being sent|may still/.test(e.message)) throw new HttpError(409, e.message);
      throw new HttpError(400, e.message);
    }
  };
  if (path === '/money/owed-back/send') {
    const provider = cfg.payments;
    if (!provider)
      throw new HttpError(503, 'Payments are not set up yet: send it by bank transfer');
    const state = await refused(() => sendMoneyBack(pool, owedEntry, provider, by, now));
    send(res, 200, { owedEntry, state });
    return true;
  }
  if (path === '/money/owed-back/by-hand') {
    const reference = str(b, 'reference', 60);
    const note = typeof b.note === 'string' ? b.note : '';
    await refused(() => recordMoneyBackByHand(pool, owedEntry, { reference, note }, by, now));
    send(res, 200, { owedEntry, state: 'by-hand' });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
