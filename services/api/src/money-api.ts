// P3.13.1: money as finance sees it (read-only: nothing here moves money). Finance (and a super
// admin) look.
//   GET /money?month=YYYY-MM          where money stands now; the month's payments, tax invoices and
//                                     credit notes, GST summary; provider messages for unknown links
//   GET /money/export?month=YYYY-MM   the month's files for the accountant (CSV text)
// P3.13.2: money owed back to brands (finance admins and a super admin send it):
//   GET  /money/owed-back             what is still owed back, with each try
//   POST /money/owed-back/send        { owedEntry }  through the payment provider (again: retries)
//   POST /money/owed-back/by-hand     { owedEntry, reference, note }  a bank transfer made by hand
// P3.13.3: agencies and aggregators:
//   GET  /money/partners                       each partner with a cut and what it is owed
//   GET  /money/partners/statement?partner=&kind=&month=   a month's statement (and its CSV)
//   POST /money/partners/pay      { partnerId, kind, amountPaise, reference, note }  finance
//   POST /money/partners/invoice  { partnerId, invoiceNo, invoiceDate, gstin?, taxablePaise,
//                                   gstPaise }  finance
//   POST /money/partners/cut      { bookingId, kind, partnerId, gstBp, rateBp?, reason }  super admin
import {
  accountantExport,
  giveCut,
  gstDocuments,
  gstSummary,
  moneyOwedBack,
  moneyPosition,
  partners,
  partnerStatement,
  paymentsIn,
  payPartner,
  recordMoneyBackByHand,
  recordPartnerInvoice,
  Refusal,
  sendMoneyBack,
  statementCsv,
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
  if (req.method === 'POST' && path.startsWith('/money/partners/'))
    return partnerAction(pool, cfg, req, res, nowMs, path);
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
    const items = await moneyOwedBack(pool);
    send(res, 200, {
      at: now,
      items,
      // The list stops at the 500 oldest.
      truncated: items.length >= 500,
      canPay: ['finance', 'super-admin'].includes(moneyRole(me.access)),
      canSend: cfg.payments !== undefined,
    });
    return true;
  }
  if (path === '/money/partners') {
    send(res, 200, {
      at: now,
      partners: await partners(pool),
      canPay: ['finance', 'super-admin'].includes(moneyRole(me.access)),
      canGiveCut: me.access.role === 'super-admin',
    });
    return true;
  }
  if (path === '/money/partners/statement') {
    const q = new URLSearchParams(query);
    const partner = q.get('partner') ?? '';
    const kind = q.get('kind');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(partner)) throw new HttpError(400, 'Which partner?');
    if (kind !== 'agency' && kind !== 'aggregator')
      throw new HttpError(400, 'kind must be agency or aggregator');
    const statement = await partnerStatement(pool, partner, kind, month);
    send(res, 200, { at: now, statement, file: statementCsv(statement) });
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

/** Pays a partner, records its invoice (finance) or gives a cut on a booking (super admin). */
async function partnerAction(
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
  const now = Math.floor(nowMs / 1000);
  const b = await jsonBody(req);
  const kind = b.kind;
  if (kind !== 'agency' && kind !== 'aggregator')
    throw new HttpError(400, 'kind must be agency or aggregator');
  const partnerId = str(b, 'partnerId', 64);
  const whole = (key: string) => {
    const v = b[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      throw new HttpError(400, `${key} must be whole paise`);
    return v;
  };
  const refused = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof Refusal) && !(e instanceof RangeError)) throw e;
      if (e.message.startsWith('Only')) throw new HttpError(403, e.message);
      if (e.message.startsWith('No booking')) throw new HttpError(404, e.message);
      if (/already/.test(e.message)) throw new HttpError(409, e.message);
      throw new HttpError(400, e.message);
    }
  };
  if (path === '/money/partners/pay') {
    if (by.role !== 'finance' && by.role !== 'super-admin')
      throw new HttpError(403, 'Only finance or a super admin records a payment to a partner');
    const amountPaise = whole('amountPaise');
    const reference = str(b, 'reference', 60);
    const note = typeof b.note === 'string' ? b.note : '';
    const seq = await refused(() =>
      payPartner(pool, { partnerId, kind, amountPaise, reference, note }, by, now),
    );
    send(res, 200, { partnerId, kind, seq });
    return true;
  }
  if (path === '/money/partners/invoice') {
    if (by.role !== 'finance' && by.role !== 'super-admin')
      throw new HttpError(403, 'Only finance or a super admin records a partner invoice');
    const invoiceNo = str(b, 'invoiceNo', 16).trim();
    const invoiceDate = str(b, 'invoiceDate', 10);
    const gstin = typeof b.gstin === 'string' && b.gstin.trim() ? b.gstin.trim() : undefined;
    const taxablePaise = whole('taxablePaise');
    const gstPaise = whole('gstPaise');
    if (invoiceNo.length < 1) throw new HttpError(400, 'The invoice number');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(partnerId)) throw new HttpError(400, 'Which partner?');
    // A real calendar date ("2027-02-30" is refused, not rolled over).
    if (
      !/^20\d{2}-\d{2}-\d{2}$/.test(invoiceDate) ||
      Number.isNaN(Date.parse(`${invoiceDate}T00:00:00Z`)) ||
      new Date(`${invoiceDate}T00:00:00Z`).toISOString().slice(0, 10) !== invoiceDate
    )
      throw new HttpError(400, 'The invoice date (YYYY-MM-DD)');
    // Only a partner with a cut: a mistyped id would never show on any statement.
    const known = await pool.query('SELECT 1 FROM booking_cuts WHERE partner_id = $1 LIMIT 1', [
      partnerId,
    ]);
    if (known.rows.length === 0) throw new HttpError(404, `No cut was given to ${partnerId}`);
    await refused(() =>
      recordPartnerInvoice(
        pool,
        {
          partnerId,
          invoiceNo,
          invoiceDate,
          ...(gstin ? { gstin } : {}),
          taxablePaise,
          gstPaise,
        },
        me.id,
      ),
    );
    send(res, 200, { partnerId, invoiceNo });
    return true;
  }
  if (path === '/money/partners/cut') {
    if (me.access.role !== 'super-admin')
      throw new HttpError(403, 'Only a super admin gives a cut');
    const bookingId = str(b, 'bookingId', 40);
    if (!/^BK-[A-Za-z0-9-]{1,36}$/.test(bookingId)) throw new HttpError(400, 'Which booking?');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(partnerId)) throw new HttpError(400, 'Which partner?');
    const gstBp = whole('gstBp');
    const rateBp = b.rateBp === undefined || b.rateBp === null ? undefined : whole('rateBp');
    const reason = str(b, 'reason', 300).trim();
    if (reason.length < 5) throw new HttpError(400, 'Say why (5 letters or more)');
    await refused(() =>
      giveCut(
        pool,
        { bookingId, kind, partnerId, gstBp, ...(rateBp === undefined ? {} : { rateBp }) },
        by,
        reason,
        now,
      ),
    );
    send(res, 200, { bookingId, kind, partnerId });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
