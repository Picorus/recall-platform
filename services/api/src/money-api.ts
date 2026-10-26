// P3.13.1: money as finance sees it (read-only: nothing here moves money). Finance (and a super
// admin) look.
//   GET /money?month=YYYY-MM          where money stands now; the month's payments, tax invoices and
//                                     credit notes, GST summary; provider messages for unknown links
//   GET /money/export?month=YYYY-MM   the month's files for the accountant (CSV text)
import {
  accountantExport,
  gstDocuments,
  gstSummary,
  moneyPosition,
  paymentsIn,
  unknownPayments,
} from '@recall/db';
import { can } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, send } from './http.js';
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
  if (path === '/money/export') {
    send(res, 200, { month, files: await accountantExport(pool, month) });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
