// P3.14.2: the business at a glance, month by month. Sales and Finance look (and a super admin).
//   GET /dashboard?month=YYYY-MM&count=6   the months ending with `month` (default: this month)
import { businessDashboard } from '@recall/db';
import { can, type StaffAccess } from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, send } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  (['sales', 'finance'] as const).some((area) => can(a, { area, change: false }));

export async function handleDashboard(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  if (path !== '/dashboard') return false;
  if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'Not allowed');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
  const now = Math.floor(nowMs / 1000);
  const q = new URLSearchParams(query);
  const month = q.get('month') ?? new Date((now + 330 * 60) * 1000).toISOString().slice(0, 7);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'Which month? (YYYY-MM)');
  const count = Number(q.get('count') ?? 6);
  if (!Number.isInteger(count) || count < 1 || count > 24)
    throw new HttpError(400, 'count: 1 to 24 months');
  send(res, 200, { at: now, months: await businessDashboard(pool, month, now, count) });
  return true;
}
