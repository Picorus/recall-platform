// P1.3.7 in the database: how many bikes were really in each area-hour (from the screens' minute
// summaries), the super admin's starting estimates, and the offer a brand sees when a request does
// not fully fit.
import {
  areaHourKey,
  candidateSlots,
  isoAt,
  lineStartsAt,
  nearbyAreas,
  offerFor,
  pastWeekDates,
  priceBookAt,
  sellableBikes,
  versionAt,
  type BookingLine,
  type CapacityRules,
  type Offer,
  type WeekSupply,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { allAreaVersions } from './areas.js';
import { inventoryFor, priceBooks } from './bookings.js';

type Slot = Pick<BookingLine, 'areaId' | 'date' | 'startHour'>;

/** A super admin's starting estimate for an area at a start hour (a new version; nothing is replaced). */
export async function setSupplyEstimate(
  pool: Pool,
  areaId: string,
  startHour: number,
  bikes: number,
  setBy: string,
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    await c.query(
      `INSERT INTO area_supply_estimates (area_id, start_hour, version, bikes, set_by)
       SELECT $1, $2, coalesce(max(version), 0) + 1, $3, $4
         FROM area_supply_estimates WHERE area_id = $1 AND start_hour = $2`,
      [areaId, startHour, bikes, setBy],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * For each past hour asked for (a business date and start hour), per area: how many different bikes
 * spent at least `minSecondsInside` inside the area in that hour, and all their moving-clock seconds
 * there. Only those hours are read (the table is split by time), never the whole city's history. A
 * minute stored twice, or split over two reports, counts at most 60 seconds per bike and area.
 */
async function history(
  c: Pick<PoolClient, 'query'>,
  areaIds: readonly string[],
  hours: readonly Slot[],
  minSecondsInside: number,
): Promise<Map<string, { distinctBikes: number; bikeSeconds: number }>> {
  const out = new Map<string, { distinctBikes: number; bikeSeconds: number }>();
  if (hours.length === 0 || areaIds.length === 0) return out;
  const r = await c.query<{
    slot: string;
    area_id: string;
    distinct_bikes: string;
    bike_seconds: string;
  }>(
    `WITH w AS (SELECT * FROM unnest($1::text[], $2::bigint[]) AS w(slot, s)),
     m AS (
       SELECT w.slot, ms.screen_id, ms.minute,
              split_part(split_part(k.key, ':', 2), '@', 1) AS area_id, k.value::int AS secs
         FROM w
         JOIN minute_summaries ms
           ON ms.minute >= to_timestamp(w.s) AND ms.minute < to_timestamp(w.s + 3600)
         CROSS JOIN LATERAL jsonb_each_text(ms.clock_at) k
        WHERE k.key LIKE 'inside:%'
     ), per_minute AS (
       SELECT slot, area_id, screen_id, minute, least(60, sum(secs)) AS secs
         FROM m WHERE area_id = ANY($3) GROUP BY 1, 2, 3, 4
     ), per_bike AS (
       SELECT slot, area_id, screen_id, sum(secs) AS secs FROM per_minute GROUP BY 1, 2, 3
     )
     SELECT slot, area_id, count(*) FILTER (WHERE secs >= $4) AS distinct_bikes,
            sum(secs) AS bike_seconds
       FROM per_bike GROUP BY 1, 2`,
    [
      hours.map((h) => `${h.date}|${h.startHour}`),
      hours.map((h) => lineStartsAt(h)),
      areaIds,
      minSecondsInside,
    ],
  );
  for (const x of r.rows)
    out.set(`${x.area_id}|${x.slot}`, {
      distinctBikes: Number(x.distinct_bikes),
      bikeSeconds: Number(x.bike_seconds),
    });
  return out;
}

/** India business date of a moment (01:30 belongs to the day before). */
const businessDate = (at: number) =>
  new Date((at + 330 * 60 - 2 * 3600) * 1000).toISOString().slice(0, 10);

/** Sellable bikes for each area-hour, from past weeks on the same weekday and hour (or the estimate). */
export async function forecastLimits(
  c: Pick<PoolClient, 'query'>,
  slots: readonly Slot[],
  rules: CapacityRules,
  now: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (slots.length === 0) return out;
  const areaIds = [...new Set(slots.map((s) => s.areaId))];
  // History starts when the fleet first reported and the area was first on; weeks from then on
  // with no bikes count as 0. Before that, the super admin's starting estimate is used.
  const fleet = await c.query<{ first: number | null }>(
    'SELECT extract(epoch FROM min(minute))::bigint AS first FROM minute_summaries',
  );
  const fleetFirst = fleet.rows[0]?.first;
  const areaFirst = new Map<string, string>();
  for (const v of await allAreaVersions(c)) {
    if (v.draft || !v.active || !areaIds.includes(v.areaId)) continue;
    const d = businessDate(Date.parse(v.validFrom) / 1000);
    const was = areaFirst.get(v.areaId);
    if (was === undefined || d < was) areaFirst.set(v.areaId, d);
  }
  const today = businessDate(now);
  const weeksOf = new Map<string, string[]>();
  const hours = new Map<string, Slot>();
  for (const s of slots) {
    const first = [
      fleetFirst == null ? '9999-12-31' : businessDate(Number(fleetFirst)),
      areaFirst.get(s.areaId) ?? '9999-12-31',
    ].sort()[1] as string;
    const dates = pastWeekDates(s.date, today, rules.lookbackWeeks, first);
    weeksOf.set(areaHourKey(s), dates);
    for (const date of dates) hours.set(`${date}|${s.startHour}`, { ...s, date });
  }
  const past = await history(c, areaIds, [...hours.values()], rules.minSecondsInside);
  const est = await c.query<{ area_id: string; start_hour: number; bikes: number }>(
    `SELECT DISTINCT ON (area_id, start_hour) area_id, start_hour, bikes FROM area_supply_estimates
      WHERE area_id = ANY($1) ORDER BY area_id, start_hour, version DESC`,
    [areaIds],
  );
  for (const s of slots) {
    const weeks: WeekSupply[] = (weeksOf.get(areaHourKey(s)) ?? []).map((date) => {
      const p = past.get(`${s.areaId}|${date}|${s.startHour}`);
      return { date, distinctBikes: p?.distinctBikes ?? 0, bikeSeconds: p?.bikeSeconds ?? 0 };
    });
    const estimate = est.rows.find(
      (e) => e.area_id === s.areaId && e.start_hour === s.startHour,
    )?.bikes;
    out.set(areaHourKey(s), sellableBikes(weeks, rules, estimate));
  }
  return out;
}

/**
 * What a brand can have now and suggestions for the rest (nearby areas, other hours, other days),
 * counting paid bookings and live holds. In the POC (no forecast, no manual limits) everything fits.
 */
export async function offerForRequest(
  pool: Pool,
  lines: readonly BookingLine[],
  now: number,
): Promise<Offer> {
  const c = await pool.connect();
  try {
    const book = priceBookAt(await priceBooks(c), isoAt(now));
    if (!book) throw new Error('No price book in force');
    const versions = await allAreaVersions(c);
    const inForce = [...new Set(versions.map((v) => v.areaId))].flatMap((id) => {
      const v = versionAt(
        versions.filter((x) => x.areaId === id),
        isoAt(now),
      );
      return v ? [v] : [];
    });
    const nearby = nearbyAreas(inForce, book.capacity.nearbyMeters);
    const slots = new Map<string, Slot>();
    for (const l of lines) {
      slots.set(areaHourKey(l), l);
      for (const { at } of candidateSlots(l, nearby)) slots.set(areaHourKey(at), at);
    }
    const asLines = [...slots.values()].map((s) => ({ ...s, bikes: 1 }));
    const inv = await inventoryFor(c, asLines, now);
    const held = new Map<string, number>();
    for (const h of inv.holds) {
      if (h.until <= now) continue;
      for (const l of h.lines) held.set(areaHourKey(l), (held.get(areaHourKey(l)) ?? 0) + l.bikes);
    }
    const free = (at: Slot) => {
      const limit = inv.limits.get(areaHourKey(at));
      if (limit === undefined) return undefined;
      return Math.max(
        0,
        limit - (inv.sold.get(areaHourKey(at)) ?? 0) - (held.get(areaHourKey(at)) ?? 0),
      );
    };
    return offerFor(lines, free, nearby, book.minBikesPerLine);
  } finally {
    c.release();
  }
}
