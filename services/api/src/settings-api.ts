// P3.17: settings. Every member sees them (support numbers and hours, centres…); a super admin
// changes them, one setting at a time, with why.
//   GET  /settings          every setting in force (version, who, when, why), the areas (for the pay
//                           zone), whether support is open now, and which outside services are on
//   POST /settings/<key>    { value, reason, version }   a new version (version: the one shown)
//   POST /settings/business { mode: 'poc' | 'regular', reason }   the business switch (P7.7.7): a
//                           super admin flips the whole business between the POC and regular
//                           business (rider pay, the calendar's limits); it counts from a day ahead
import {
  areaRecords,
  businessModeHistory,
  canSwitch,
  cancelScheduledPoc,
  owePocMonthsBack,
  stopPocLinks,
  businessModes,
  pocPhaseAt,
  pocMonthsSetting,
  EarlyEnd,
  Refusal,
  saveSetting,
  setBusinessMode,
  settingRecords,
  type SettingRecords,
} from '@recall/db';
import {
  modeAt,
  pocAlerts,
  pocStartsFrom,
  SETTING_KEYS,
  switchCountsFrom,
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
    // The business switch: where it stands, what a switch now would count from, and every switch.
    const history = await businessModeHistory(pool);
    const setters = new Map(
      (
        await pool.query<{ id: string; name: string }>(
          'SELECT id, name FROM staff WHERE id = ANY($1)',
          [history.map((h) => h.setBy)],
        )
      ).rows.map((x) => [x.id, x.name]),
    );
    const phase = await pocPhaseAt(pool, now);
    const months = await pocMonthsSetting(pool);
    const business = {
      mode: modeAt(await businessModes(pool), now),
      // A switch already made that has not started yet (counts from a later day).
      next: history.find((h) => h.from > now && !h.cancelled) ?? null,
      canSwitch: me.access.role === 'super-admin' && (await canSwitch(pool, now)),
      // P7.8: the POC is scheduled, running or ended (by itself after its months, or by hand).
      poc: phase,
      pocMonths: months,
      alerts: pocAlerts(phase, months, now),
      pocEnded: phase.phase === 'ended',
      pocFrom: pocStartsFrom(now),
      regularFrom: switchCountsFrom(now),
      history: history.map((h) => ({ ...h, setBy: setters.get(h.setBy) ?? h.setBy })),
    };
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
      business,
    });
    return true;
  }

  // P7.8 (Prateek, 29 Oct 2026): a super admin cancels a POC scheduled and not started, with why.
  if (path === '/settings/business/cancel') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
    const me = await staffFor(pool, cfg, req, nowMs);
    if (me.access.role !== 'super-admin')
      throw new HttpError(403, 'Only a super admin cancels the POC');
    const reason = str(await jsonBody(req), 'reason', 300).trim();
    if (reason.length < 5) throw new HttpError(400, 'Say why (a few words)');
    try {
      const from = await cancelScheduledPoc(pool, { id: me.id, role: me.access.role }, reason, now);
      // Its months' payment links are stopped (money taken anyway is owed back), and months already
      // paid for it never ran: owed back. Both are tried again by the payments job if this fails.
      if (cfg.payments)
        await stopPocLinks(pool, cfg.payments, now).catch((e: unknown) =>
          console.error(`payments: stopping cancelled POC links: ${(e as Error).message}`),
        );
      const owed = await owePocMonthsBack(pool, now);
      send(res, 200, { cancelled: from, owedBack: owed });
    } catch (e) {
      if (e instanceof Error && /No POC is scheduled|has started/.test(e.message))
        throw new HttpError(400, e.message);
      throw e;
    }
    return true;
  }

  if (path === '/settings/business') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
    const me = await staffFor(pool, cfg, req, nowMs);
    if (me.access.role !== 'super-admin')
      throw new HttpError(403, 'Only a super admin switches the business');
    const b = await jsonBody(req);
    const mode = b.mode;
    if (mode !== 'poc' && mode !== 'regular') throw new HttpError(400, 'POC or regular business?');
    const reason = str(b, 'reason', 300).trim();
    if (reason.length < 5) throw new HttpError(400, 'Say why (a few words)');
    try {
      const from = await setBusinessMode(
        pool,
        mode,
        { id: me.id, role: me.access.role },
        reason,
        now,
        // P7.8: ending the POC before its planned end needs the super admin's confirmation.
        { early: b.early === true },
      );
      send(res, 200, { mode, from });
    } catch (e) {
      if (e instanceof EarlyEnd)
        throw new HttpError(409, e.message, { code: 'poc-early', n: e.days });
      // The switch's own rules (one switch at a time, the POC runs once): said in its words.
      if (e instanceof Error && /already set|already on|POC has ended/.test(e.message))
        throw new HttpError(400, e.message);
      throw e;
    }
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
