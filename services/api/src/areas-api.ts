// P3.5: the Areas page's API. Looking needs Sales or Operations; changing a shape, its edge zone or
// name (a new version, or a draft for later) needs an Operations admin; adding an area and turning
// one on or off needs a super admin (DECISIONS, 22 Oct 2026). Every save is checked by the area
// rules (corners, no crossing border, no overlap or touching, edge zone 0–2,000 m) and gives why.
//   GET  /areas                    every area: its newest version and its history
//   POST /areas/check              { areaId?, ring, edgeMeters, active? } → problems, nothing saved
//   POST /areas                    { areaId, name, city, ring, edgeMeters, validFrom?, draft, reason }
//   POST /areas/<id>/versions      { name?, ring?, edgeMeters?, draft?, validFrom?, reason }
//   POST /areas/<id>/active        { active, validFrom?, reason }
import {
  AreaError,
  can,
  checkArea,
  createArea,
  DEFAULT_EDGE_METERS,
  reviseArea,
  setAreaActive,
  type AreaProblem,
  type AreaVersion,
  type LatLng,
  type StaffAccess,
} from '@recall/domain';
import { areaHistory, areaRecords, saveAreaVersion } from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const MAX_CORNERS = 200;

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) || can(a, { area: 'operations', change: false });

/** A problem in words, naming the other area by its name. */
export function problemText(p: AreaProblem, names: ReadonlyMap<string, string>): string {
  return p.kind === 'overlap'
    ? `overlaps or touches ${names.get(p.withAreaId) ?? p.withAreaId}: leave a gap (the edge zones cover it)`
    : p.detail;
}

function readRing(x: unknown): LatLng[] {
  if (!Array.isArray(x) || x.length < 3 || x.length > MAX_CORNERS)
    throw new HttpError(400, `Give 3 to ${MAX_CORNERS} corners`);
  return x.map((p) => {
    const lat = (p as { lat?: unknown }).lat;
    const lng = (p as { lng?: unknown }).lng;
    if (typeof lat !== 'number' || typeof lng !== 'number')
      throw new HttpError(400, 'Each corner needs lat and lng');
    return { lat, lng };
  });
}

function readEdge(x: unknown): number {
  if (typeof x !== 'number' || !Number.isInteger(x))
    throw new HttpError(400, 'The edge zone is whole metres');
  return x;
}

/**
 * When a change starts: the time given (UTC, never in the past: plays already counted must keep
 * the shape they were counted in), or now. Whole seconds.
 */
function startOf(x: unknown, nowMs: number): string {
  const now = new Date(Math.floor(nowMs / 1000) * 1000).toISOString();
  if (x === undefined || x === null || x === '') return now;
  if (typeof x !== 'string' || Number.isNaN(Date.parse(x)) || !x.endsWith('Z'))
    throw new HttpError(400, 'validFrom must be a UTC time like 2026-11-01T00:00:00Z');
  const ms = Date.parse(x);
  if (ms < nowMs - 60_000) throw new HttpError(400, 'A change cannot start in the past');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

export async function handleAreas(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/areas' && !path.startsWith('/areas/')) return false;
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');

  const me = await staffFor(pool, cfg, req, nowMs);
  if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
  const records = await areaRecords(pool);
  const all = records.map((r) => r.area);
  const names = new Map(all.map((a) => [a.areaId, a.name]));
  const othersThan = (id: string) => all.filter((a) => a.areaId !== id);
  const refused = (e: unknown): never => {
    if (e instanceof AreaError)
      throw new HttpError(400, e.problems.map((p) => problemText(p, names)).join('; '));
    throw e;
  };

  if (method === 'GET' && path === '/areas') {
    const byId = new Map<string, typeof records>();
    for (const r of records) byId.set(r.area.areaId, [...(byId.get(r.area.areaId) ?? []), r]);
    const areas = [...byId.values()].map((h) => ({ latest: h[h.length - 1]?.area, history: h }));
    send(res, 200, { at: Math.floor(nowMs / 1000), areas, defaultEdgeMeters: DEFAULT_EDGE_METERS });
    return true;
  }
  if (method !== 'POST') throw new HttpError(404, 'Not found');
  const b = await jsonBody(req);

  if (path === '/areas/check') {
    const areaId = typeof b.areaId === 'string' ? b.areaId : 'new-area';
    const draftOf: AreaVersion = {
      areaId,
      version: 1,
      name: 'check',
      city: 'check',
      ring: readRing(b.ring),
      edgeMeters: readEdge(b.edgeMeters),
      validFrom: new Date(Math.floor(nowMs / 1000) * 1000).toISOString(),
      draft: false,
      active: b.active !== false,
    };
    const problems = checkArea(draftOf, othersThan(areaId)).filter((p) => p.kind !== 'bad-id');
    send(res, 200, { problems: problems.map((p) => problemText(p, names)) });
    return true;
  }

  const reason = str(b, 'reason', 200).trim();
  if (reason.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
  const who = `${me.name} (${me.id})`.slice(0, 120);

  if (path === '/areas') {
    if (!can(me.access, { superAdmin: true }))
      throw new HttpError(403, 'Only a super admin adds areas');
    let area: AreaVersion;
    try {
      area = createArea(
        {
          areaId: str(b, 'areaId', 60),
          name: str(b, 'name', 80).trim(),
          city: str(b, 'city', 80).trim(),
          ring: readRing(b.ring),
          edgeMeters: readEdge(b.edgeMeters ?? DEFAULT_EDGE_METERS),
          validFrom: startOf(b.validFrom, nowMs),
          draft: b.draft === true,
        },
        all,
      );
    } catch (e) {
      return refused(e);
    }
    await saveAreaVersion(pool, area, who, reason).catch(refused);
    send(res, 200, { area });
    return true;
  }

  const m = /^\/areas\/([a-z0-9-]{1,60})\/(versions|active)$/.exec(path);
  const areaId = m?.[1] ?? '';
  if (!m) throw new HttpError(404, 'Not found');
  const history = await areaHistory(pool, areaId);
  if (history.length === 0) throw new HttpError(404, 'No such area');
  let next: AreaVersion;
  try {
    if (m[2] === 'active') {
      if (!can(me.access, { superAdmin: true }))
        throw new HttpError(403, 'Only a super admin turns areas on or off');
      if (typeof b.active !== 'boolean') throw new HttpError(400, 'active must be true or false');
      next = setAreaActive(history, b.active, startOf(b.validFrom, nowMs), othersThan(areaId));
    } else {
      if (!can(me.access, { area: 'operations', change: true }))
        throw new HttpError(403, 'Only an Operations admin changes area shapes');
      if (b.active !== undefined)
        throw new HttpError(403, 'Only a super admin turns areas on or off');
      next = reviseArea(
        history,
        {
          name: b.name === undefined ? undefined : str(b, 'name', 80).trim(),
          ring: b.ring === undefined ? undefined : readRing(b.ring),
          edgeMeters: b.edgeMeters === undefined ? undefined : readEdge(b.edgeMeters),
          draft: typeof b.draft === 'boolean' ? b.draft : undefined,
        },
        startOf(b.validFrom, nowMs),
        othersThan(areaId),
      );
    }
  } catch (e) {
    return refused(e);
  }
  await saveAreaVersion(pool, next, who, reason).catch(refused);
  send(res, 200, { area: next });
  return true;
}
