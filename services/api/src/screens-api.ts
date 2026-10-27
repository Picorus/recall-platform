// P3.4: the Screens page's API. Looking needs Operations; changing (repair, swap, take off, retire,
// pause or roll back a player update) needs an Operations admin and a reason, logged with who.
//   GET  /screens                         every screen, stock counts, the rollout, versions in use
//   POST /screens/<id>/service            { kind: to-repair | repaired | retired, reason }
//   POST /screens/<id>/unfit              { reason }
//   POST /screens/<id>/swap               { newScreenId, reason }
//   POST /screens/<id>/lost               { reason, lostAt? }  lost or stolen: nothing it signs from
//                                         lostAt (default now) counts, its line closes (P7.1)
//   POST /rollout/pause                   { pause: true | false, reason }
//   POST /rollout/roll-back               { reason }
import { isScreenId } from '@recall/domain';
import {
  pauseRollout,
  Refusal,
  reportScreenLost,
  rollBack,
  rolloutStatus,
  screenList,
  serviceScreen,
  stockCounts,
  swapScreen,
  unfitScreen,
  versionsInUse,
  type ServiceKind,
} from '@recall/db';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const look = { area: 'operations', change: false } as const;
const act = { area: 'operations', change: true } as const;
const KINDS: readonly ServiceKind[] = ['to-repair', 'repaired', 'retired'];

/** A rule's refusal (or a value out of range) is the caller's 400 with its reason; anything else is a fault. */
async function refusedAs400<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Refusal || e instanceof RangeError) throw new HttpError(400, e.message);
    throw e;
  }
}

function reasonOf(b: Record<string, unknown>): string {
  const r = str(b, 'reason', 200).trim();
  if (r.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
  return r;
}

export async function handleScreens(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const ours = path === '/screens' || path.startsWith('/screens/') || path.startsWith('/rollout/');
  if (!ours) return false;
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');

  if (method === 'GET' && path === '/screens') {
    await staffFor(pool, cfg, req, nowMs, look);
    const screens = await screenList(pool, now);
    send(res, 200, {
      at: now,
      screens,
      counts: stockCounts(screens),
      rollout: (await rolloutStatus(pool)) ?? null,
      versions: await versionsInUse(pool),
    });
    return true;
  }
  if (method !== 'POST') throw new HttpError(404, 'Not found');

  const by = await staffFor(pool, cfg, req, nowMs, act);
  const who = `${by.name} (${by.id})`.slice(0, 80);
  const b = await jsonBody(req);

  if (path === '/rollout/pause') {
    if (typeof b.pause !== 'boolean') throw new HttpError(400, 'pause must be true or false');
    const pause = b.pause;
    const done = await refusedAs400(() => pauseRollout(pool, pause, who, reasonOf(b), nowMs));
    if (!done)
      throw new HttpError(409, pause ? 'No running update to pause' : 'No paused update to resume');
    send(res, 200, { ok: true });
    return true;
  }
  if (path === '/rollout/roll-back') {
    const done = await rollBack(pool, who, reasonOf(b), nowMs);
    if (!done) throw new HttpError(409, 'No update to roll back');
    send(res, 200, { ok: true });
    return true;
  }

  const m = /^\/screens\/([^/]+)\/(service|unfit|swap|lost)$/.exec(path);
  const screenId = m?.[1] ?? '';
  if (!m || !isScreenId(screenId)) throw new HttpError(404, 'Not found');
  const reason = reasonOf(b);
  if (m[2] === 'service') {
    const kind = str(b, 'kind', 20) as ServiceKind;
    if (!KINDS.includes(kind))
      throw new HttpError(400, 'kind must be to-repair, repaired or retired');
    await refusedAs400(() => serviceScreen(pool, { screenId, kind, reason, by: who, now }));
  } else if (m[2] === 'lost') {
    const lostAt = b.lostAt === undefined ? now : b.lostAt;
    if (typeof lostAt !== 'number' || !Number.isInteger(lostAt))
      throw new HttpError(400, 'lostAt must be a time in seconds');
    const done = await refusedAs400(() =>
      reportScreenLost(pool, { screenId, lostAt, reason, by: who, now }),
    );
    send(res, 200, { ok: true, ...done });
    return true;
  } else if (m[2] === 'unfit') {
    await refusedAs400(() => unfitScreen(pool, screenId, reason, who, now));
  } else {
    const newScreenId = str(b, 'newScreenId', 20);
    if (!isScreenId(newScreenId)) throw new HttpError(400, 'Not a screen id');
    await refusedAs400(() =>
      swapScreen(pool, { oldScreenId: screenId, newScreenId, reason, by: who, now }),
    );
  }
  send(res, 200, { ok: true });
  return true;
}
