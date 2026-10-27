// P3.16: the audit log. A super admin only (it shows every part of the business and every member).
//   GET /audit?q=&area=&from=YYYY-MM-DD&to=YYYY-MM-DD&before=<next>   newest first, 200 a page
//   GET /audit/export?q=&area=&from=&to=                               the same as a CSV file
import { AUDIT_AREAS, auditCsv, auditLog, Refusal, type AuditArea } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, send } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

/** An India date "YYYY-MM-DD" as UTC seconds at its start (00:00 India time). */
const indiaDay = (d: string | null, what: string): number | undefined => {
  if (d === null || d === '') return undefined;
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(d) ||
    new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d
  )
    throw new HttpError(400, `${what}: a date (YYYY-MM-DD)`);
  return Date.parse(`${d}T00:00:00+05:30`) / 1000;
};

export async function handleAudit(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/audit' && path !== '/audit/export') return false;
  if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'Not allowed');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (me.access.role !== 'super-admin')
    throw new HttpError(403, 'Only a super admin sees the audit log');
  const q = new URLSearchParams(query);
  const area = q.get('area') || undefined;
  if (area !== undefined && !(AUDIT_AREAS as readonly string[]).includes(area))
    throw new HttpError(400, 'Which part of the business?');
  const text = (q.get('q') ?? '').slice(0, 200);
  const from = indiaDay(q.get('from'), 'From');
  const toDay = indiaDay(q.get('to'), 'To');
  const filter = {
    ...(text ? { text } : {}),
    ...(area ? { area: area as AuditArea } : {}),
    ...(from !== undefined ? { from } : {}),
    // "To" is the whole day.
    ...(toDay !== undefined ? { to: toDay + 86_400 } : {}),
  };
  try {
    if (path === '/audit/export') {
      send(res, 200, { name: 'recall-audit-log.csv', ...(await auditCsv(pool, filter)) });
      return true;
    }
    const before = q.get('before');
    const page = await auditLog(pool, { ...filter, ...(before ? { before } : {}) });
    send(res, 200, { at: Math.floor(nowMs / 1000), areas: AUDIT_AREAS, ...page });
  } catch (e) {
    if (e instanceof Refusal) throw new HttpError(400, e.message);
    throw e;
  }
  return true;
}
