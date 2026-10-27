// P3.17: settings. Every member sees them (support numbers and hours, centres…); a super admin
// changes them, one setting at a time, with why.
//   GET  /settings          every setting in force (version, who, when, why), the areas (for the pay
//                           zone), whether support is open now, and which outside services are on
//   POST /settings/<key>    { value, reason, version }   a new version (version: the one shown)
import { areaRecords, Refusal, saveSetting, settingRecords, type SettingRecords } from '@recall/db';
import {
  SETTING_KEYS,
  STAFF_AREAS,
  STAFF_ROLES,
  supportOpenAt,
  type SettingKey,
} from '@recall/domain';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const SETTING = /^\/settings\/([A-Za-z]{1,40})$/;

export async function handleSettings(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/settings' && !path.startsWith('/settings/')) return false;
  const method = req.method ?? 'GET';
  const now = Math.floor(nowMs / 1000);

  if (path === '/settings') {
    if (method !== 'GET') throw new HttpError(405, 'Not allowed');
    const me = await staffFor(pool, cfg, req, nowMs);
    const saved: SettingRecords = await settingRecords(pool);
    // Who saved each: their name (the record keeps their staff id).
    const ids = Object.values(saved).flatMap((r) => (r.savedBy ? [r.savedBy] : []));
    const names = new Map(
      (
        await pool.query<{ id: string; name: string }>(
          'SELECT id, name FROM staff WHERE id = ANY($1)',
          [ids],
        )
      ).rows.map((x) => [x.id, x.name]),
    );
    const records = Object.fromEntries(
      Object.entries(saved).map(([k, r]) => [
        k,
        { ...r, savedBy: r.savedBy && (names.get(r.savedBy) ?? r.savedBy) },
      ]),
    ) as unknown as SettingRecords;
    // The newest version of each area (its name today), for picking the pay zone's areas.
    const areas = new Map<string, string>();
    for (const r of await areaRecords(pool)) areas.set(r.area.areaId, r.area.name);
    send(res, 200, {
      at: now,
      settings: records,
      canChange: me.access.role === 'super-admin',
      supportOpen: supportOpenAt(records.support.value, now),
      areas: [...areas].map(([id, name]) => ({ id, name })),
      roles: STAFF_ROLES,
      staffAreas: STAFF_AREAS,
      connections: cfg.connections ?? [],
    });
    return true;
  }

  const m = SETTING.exec(path);
  if (!m || !(SETTING_KEYS as readonly string[]).includes(m[1] ?? ''))
    throw new HttpError(404, 'No such setting');
  if (method !== 'POST') throw new HttpError(405, 'Not allowed');
  const origin = req.headers.origin;
  if (!origin || !cfg.origins.includes(origin)) throw new HttpError(403, 'Not from the admin site');
  const me = await staffFor(pool, cfg, req, nowMs);
  if (me.access.role !== 'super-admin')
    throw new HttpError(403, 'Only a super admin changes settings');
  const b = await jsonBody(req);
  const version = b.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0)
    throw new HttpError(400, 'Which version were you changing? Reload the page');
  try {
    const saved = await saveSetting(
      pool,
      m[1] as SettingKey,
      b.value,
      { id: me.id, role: me.access.role },
      str(b, 'reason', 300),
      version,
    );
    send(res, 200, { version: saved });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    throw new HttpError(e.message.includes('meanwhile') ? 409 : 400, e.message);
  }
  return true;
}
