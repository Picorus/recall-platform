// P4.4 in the database: the rider app's "where am I" map (kept just in case, like other riding
// apps). The screen on his bike is the only source of where he is (hard rule 1): his last position
// is the last live report of a screen while he rode it (never one sent before it was his, nor after),
// his route today the live reports of today's business day while he rode, thinned. The street name
// and the roads around him come from the maps adapter (hard rule 4; a fake on a laptop), bounded to
// a small square around him whatever the provider answers. Nobody else's position is ever read.
import type { MapsAdapter } from '@recall/adapters';
import {
  boundRoads,
  DEFAULT_WHERE_RULES,
  positionAge,
  thinRoute,
  todayOf,
  type MapRoad,
  type WhereRules,
} from '@recall/domain';
import type { Pool } from 'pg';
import { stretchesOf } from './rider-today.js';

type Q = Pick<Pool, 'query'>;

/** How far back his last position is still shown (hours), as on the fleet map. */
export const WHERE_POSITION_HOURS = 24;

export interface RiderWhere {
  readonly at: number;
  /** His last position, or null when his screen has sent none in the last 24 hours. */
  readonly position: {
    readonly t: number;
    readonly lat: number;
    readonly lng: number;
    readonly moving: boolean;
    /** "live" (just now), "recent" (show its time) or "old" (may be wrong now). */
    readonly age: 'live' | 'recent' | 'old';
  } | null;
  /** The street there, from the maps adapter (null: none known, or no maps set up). */
  readonly street: string | null;
  /** His route today (business day), oldest first, thinned: [lat, lng] pairs. */
  readonly route: readonly (readonly [number, number])[];
  /** The middle of the map: his position, else the end of his route; null when neither. */
  readonly centre: { readonly lat: number; readonly lng: number } | null;
  /** How far around the centre the map reaches (metres). */
  readonly radiusM: number;
  /**
   * The roads around the centre for the base map; null when not asked for (the phone already has
   * them for a centre near this one), or when no maps provider can give roads.
   */
  readonly roads: readonly MapRoad[] | null;
  /** The credit the roads' source needs shown with them (null: none, or no roads sent). */
  readonly credit: string | null;
}

interface Live {
  readonly t: number;
  readonly lat: number;
  readonly lng: number;
  readonly moving: boolean;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** A maps call that fails, or takes longer than 2 seconds, gives `fallback` (the map still opens). */
async function inTime<T>(call: Promise<T>, fallback: T, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((ok) => {
    timer = setTimeout(() => ok(fallback), ms);
  });
  try {
    return await Promise.race([call.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only roads shaped as the adapter promises (a provider may send anything). */
function wellShaped(roads: unknown): MapRoad[] {
  if (!Array.isArray(roads)) return [];
  return roads.flatMap((r: unknown) => {
    const points = (r as { points?: unknown } | null)?.points;
    if (!Array.isArray(points)) return [];
    return [
      {
        main: (r as { main?: unknown }).main === true,
        points: points.flatMap((p: unknown) =>
          Array.isArray(p) && finite(p[0]) && finite(p[1]) ? [[p[0], p[1]] as const] : [],
        ),
      },
    ];
  });
}

/** Live reports of one screen in [from, to), newest first when `last`, else oldest first. */
async function livesOf(
  pool: Q,
  screenId: string,
  from: number,
  to: number,
  limit: number,
  last: boolean,
): Promise<Live[]> {
  const r = await pool.query<{
    t: string;
    body: { lat?: unknown; lng?: unknown; moving?: unknown };
  }>(
    `SELECT extract(epoch FROM made_at)::bigint AS t, body FROM screen_reports
      WHERE screen_id = $1 AND kind = 'live'
        AND made_at >= to_timestamp($2) AND made_at < to_timestamp($3)
      ORDER BY made_at ${last ? 'DESC' : 'ASC'}, seq ${last ? 'DESC' : 'ASC'} LIMIT $4`,
    [screenId, from, to, limit],
  );
  return r.rows.flatMap((x) =>
    finite(x.body.lat) &&
    finite(x.body.lng) &&
    Math.abs(x.body.lat) <= 90 &&
    Math.abs(x.body.lng) <= 180
      ? [{ t: Number(x.t), lat: x.body.lat, lng: x.body.lng, moving: x.body.moving === true }]
      : [],
  );
}

/** The most live reports read for one day's route (the newest; 18 hours at one every 30 s). */
const ROUTE_READ = 2_200;
/** Live reports read for his last position: the newest good one among them is used. */
const POSITION_READ = 5;

export async function riderWhere(
  pool: Q,
  maps: MapsAdapter | undefined,
  riderId: string,
  now: number,
  opts: {
    /** Send the roads (false: the phone has them for a centre near this one). */
    readonly roads?: boolean;
    readonly rules?: WhereRules;
  } = {},
): Promise<RiderWhere> {
  const rules = opts.rules ?? DEFAULT_WHERE_RULES;
  const since = now - WHERE_POSITION_HOURS * 3600;
  const today = todayOf(now);
  const opens = Date.parse(`${today}T02:30:00Z`) / 1000;
  // The business day closes at 02:00 India time; the route stops there.
  const closes = opens + 18 * 3600;
  const until = now + 1;
  const stretches = await stretchesOf(pool, riderId, Math.min(since, opens), until);

  // His last position: the newest live report of any screen while it was his.
  let position: Live | undefined;
  for (const s of stretches) {
    const from = Math.max(s.from, since);
    const to = Math.min(s.to, until);
    if (from >= to) continue;
    // A few, so one malformed newest report does not hide a good position before it.
    const [p] = await livesOf(pool, s.screenId, from, to, POSITION_READ, true);
    if (p && (!position || p.t > position.t)) position = p;
  }
  // His route today, while he rode.
  const route: Live[] = [];
  for (const s of stretches) {
    const from = Math.max(s.from, opens);
    const to = Math.min(s.to, until, closes);
    if (from >= to) continue;
    // The newest, so a long day loses its start, never where he is now (sorted below).
    route.push(...(await livesOf(pool, s.screenId, from, to, ROUTE_READ, true)));
  }
  route.sort((a, b) => a.t - b.t);
  const thin = thinRoute(route, rules.maxRoutePoints).map(
    (p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5] as const,
  );
  const end = route.at(-1);
  const centre = position
    ? { lat: position.lat, lng: position.lng }
    : end
      ? { lat: end.lat, lng: end.lng }
      : null;

  const street =
    position && maps
      ? ((await inTime(maps.streetAt(position.lat, position.lng), undefined)) ?? null)
      : null;
  const roads =
    centre && maps?.roadsNear && opts.roads !== false
      ? boundRoads(
          wellShaped(await inTime(maps.roadsNear(centre.lat, centre.lng, rules.roadsRadiusM), [])),
          centre,
          rules.roadsRadiusM,
          rules,
        )
      : null;
  return {
    at: now,
    position: position
      ? {
          t: position.t,
          lat: position.lat,
          lng: position.lng,
          moving: position.moving,
          age: positionAge(now, position.t, rules),
        }
      : null,
    street,
    route: thin,
    centre,
    radiusM: rules.roadsRadiusM,
    roads,
    credit: roads && maps?.credit ? maps.credit : null,
  };
}
