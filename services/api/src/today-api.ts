// P3.2: GET /today, the admin Today page's numbers. Every signed-in member may open it; each part
// is read only when their areas cover it (a super admin sees all):
// - bikes now and alerts: Operations;
// - hours sold vs delivered, and make-ups owed: Sales or Operations;
// - refunds this week: Finance, Sales or Operations.
import { can, type StaffAccess, type StaffArea } from '@recall/domain';
import { alertsNow, fleetNow, hoursSoldToday, makeUpsOwed, refundsThisWeek } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, send } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const sees = (a: StaffAccess, areas: readonly StaffArea[]) =>
  areas.some((area) => can(a, { area, change: false }));

/** What each part needs (any one of the areas). */
export const TODAY_PARTS = {
  fleet: ['operations'],
  alerts: ['operations'],
  hours: ['sales', 'operations'],
  makeUps: ['sales', 'operations'],
  refunds: ['finance', 'sales', 'operations'],
} as const satisfies Record<string, readonly StaffArea[]>;

export async function handleToday(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0];
  if (path !== '/today') return false;
  if (req.method !== 'GET') throw new HttpError(405, 'Not allowed');
  const m = await staffFor(pool, cfg, req, nowMs);
  const now = Math.floor(nowMs / 1000);
  const a = m.access;
  const [fleet, alerts, hours, makeUps, refunds] = await Promise.all([
    sees(a, TODAY_PARTS.fleet) ? fleetNow(pool, now) : undefined,
    sees(a, TODAY_PARTS.alerts) ? alertsNow(pool, now) : undefined,
    sees(a, TODAY_PARTS.hours) ? hoursSoldToday(pool, now) : undefined,
    sees(a, TODAY_PARTS.makeUps) ? makeUpsOwed(pool, now) : undefined,
    sees(a, TODAY_PARTS.refunds) ? refundsThisWeek(pool, now) : undefined,
  ]);
  send(res, 200, { at: now, fleet, alerts, hours, makeUps, refunds });
  return true;
}
