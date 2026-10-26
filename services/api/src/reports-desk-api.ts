// P3.14.1: final campaign reports in admin. Sales, Support and Finance look (and a super admin);
// Sales and Support admins (and a super admin) send a report again to the brand.
//   GET  /reports                       ended campaigns and where each report stands
//   GET  /reports/<id>/page             the report as the brand sees it (HTML)
//   GET  /reports/<id>/pdf              its PDF (base64)
//   POST /reports/<id>/resend           { channel: 'whatsapp' | 'email' }
import { campaignReportFor, Refusal, reportList, resendReport } from '@recall/db';
import { can, type StaffAccess } from '@recall/domain';
import { renderReportHtml, renderReportPdf } from '@recall/workers';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send } from './http.js';
import { reportRender } from './report-render.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const AREAS = ['sales', 'support', 'finance'] as const;
const mayLook = (a: StaffAccess) => AREAS.some((area) => can(a, { area, change: false }));
const mayResend = (a: StaffAccess) =>
  (['sales', 'support'] as const).some((area) => can(a, { area, change: true }));

export async function handleReportsDesk(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/'] = (req.url ?? '/').split('?');
  if (path !== '/reports' && !path.startsWith('/reports/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);
  const one = /^\/reports\/(BK-[A-Za-z0-9-]{1,36})\/(page|pdf|resend)$/.exec(path);
  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (path === '/reports') {
      send(res, 200, {
        at: now,
        rows: await reportList(pool, now),
        canResend: mayResend(me.access) && cfg.reports !== undefined,
        sending: cfg.reports !== undefined,
      });
      return true;
    }
    if (!one || one[2] === 'resend') throw new HttpError(404, 'Not found');
    const report = await campaignReportFor(pool, one[1] ?? '');
    if (!report) throw new HttpError(404, 'No report for this booking yet');
    if (one[2] === 'page') send(res, 200, { html: renderReportHtml(report) });
    else
      send(res, 200, {
        name: `RECALL-report-${report.bookingId}.pdf`,
        base64: Buffer.from(await renderReportPdf(report)).toString('base64'),
      });
    return true;
  }
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  if (!one || one[2] !== 'resend') throw new HttpError(404, 'Not found');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayResend(me.access))
    throw new HttpError(403, 'Only Sales or Support admins send a report again');
  const reports = cfg.reports;
  if (!reports)
    throw new HttpError(503, 'Messages are not set up yet: reports cannot be sent from here');
  const b = await jsonBody(req);
  const channel = b.channel;
  if (channel !== 'whatsapp' && channel !== 'email')
    throw new HttpError(400, 'channel must be whatsapp or email');
  try {
    const status = await resendReport(
      pool,
      reports.messages,
      reportRender(reports.portalUrl),
      one[1] ?? '',
      channel,
      { id: me.id, name: me.name },
      now,
    );
    send(res, 200, { channel, status });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    if (e.message.startsWith('No report')) throw new HttpError(404, e.message);
    if (/just/.test(e.message)) throw new HttpError(409, e.message);
    throw new HttpError(400, e.message);
  }
  return true;
}
