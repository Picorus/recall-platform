// P3.3: the fleet map's API. Looking needs Operations (or a super admin); sending a command needs
// an Operations admin, with a reason, and is logged before it goes (P2.12). The gateway sends it
// within seconds to a screen whose line is open, else at its next hello.
//   GET  /fleet                        every screen: state, last position, bike, alerts; the areas
//   GET  /fleet/screens/<id>           one screen: route (2 h), health, fittings, commands
//   POST /fleet/screens/<id>/commands  { command, value, reason }
import { COMMANDS, isScreenId, type CommandName } from '@recall/domain';
import { allAreaVersions, fleetScreens, issueCommand, screenDetail } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

/** Commands staff send from the map. The fitting check is started by the fitter's app (P4). */
export const MAP_COMMANDS = COMMANDS.filter((c) => c !== 'fitting-check');

const look = { area: 'operations', change: false } as const;
const act = { area: 'operations', change: true } as const;

export async function handleFleet(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/fleet' && !path.startsWith('/fleet/')) return false;
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');

  if (method === 'GET' && path === '/fleet') {
    await staffFor(pool, cfg, req, nowMs, look);
    // The version of each area in force now, on and not a draft: what is sold and counted.
    const latest = new Map<string, Awaited<ReturnType<typeof allAreaVersions>>[number]>();
    for (const a of await allAreaVersions(pool))
      if (Date.parse(a.validFrom) <= nowMs) latest.set(a.areaId, a);
    const areas = [...latest.values()]
      .filter((a) => a.active && !a.draft)
      .map((a) => ({
        areaId: a.areaId,
        name: a.name,
        version: a.version,
        ring: a.ring,
        edgeMeters: a.edgeMeters,
      }));
    send(res, 200, {
      at: now,
      screens: await fleetScreens(pool, now),
      areas,
      commands: MAP_COMMANDS,
    });
    return true;
  }

  const one = /^\/fleet\/screens\/([^/]+)(\/commands)?$/.exec(path);
  const screenId = one?.[1] ?? '';
  if (!one || !isScreenId(screenId)) throw new HttpError(404, 'Not found');

  if (method === 'GET' && !one[2]) {
    await staffFor(pool, cfg, req, nowMs, look);
    const d = await screenDetail(pool, screenId, now);
    if (!d) throw new HttpError(404, 'No such screen');
    send(res, 200, d);
    return true;
  }

  if (method === 'POST' && one[2]) {
    const by = await staffFor(pool, cfg, req, nowMs, act);
    const b = await jsonBody(req);
    const command = str(b, 'command', 40) as CommandName;
    if (!(MAP_COMMANDS as readonly string[]).includes(command))
      throw new HttpError(400, 'Unknown command');
    const value = b.value === undefined || b.value === null ? null : b.value;
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value)))
      throw new HttpError(400, 'value must be a whole number or empty');
    const reason = str(b, 'reason', 200).trim();
    if (reason.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
    const known = await pool.query('SELECT 1 FROM screens WHERE screen_id = $1', [screenId]);
    if (known.rowCount === 0) throw new HttpError(404, 'No such screen');
    try {
      const c = await issueCommand(pool, {
        // A second click within 30 seconds returns the first command, not a new one.
        unlessRepeatWithinMs: 30_000,
        screenId,
        command,
        value,
        by: `${by.name} (${by.id})`.slice(0, 80),
        reason,
        nowMs,
      });
      send(res, 200, { id: c.id, repeated: c.repeated === true });
    } catch (e) {
      if (e instanceof RangeError)
        throw new HttpError(400, e.message.replace(/^command: /, 'Command: '));
      throw e;
    }
    return true;
  }
  throw new HttpError(405, 'Not allowed');
}
