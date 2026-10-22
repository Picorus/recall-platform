// P1.3.7 in the database: how many bikes were really in each area-hour (from the screens' minute
// summaries), the super admin's starting estimates, and the offer a brand sees when a request does
// not fully fit.
import {
  areaHourKey,
  candidateSlots,
  isoAt,
  nearbyAreas,
  offerFor,
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

/** Weekday (0 = Sunday) of a business date. */
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

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
 * Past weeks for these areas and start hours: per business date, how many different bikes spent at
 * least `minSecondsInside` inside each area in that hour, and all their moving-clock seconds there.
 */
async function history(
  c: Pick<PoolClient, 'query'>,
  areaIds: readonly string[],
  sinceSeconds: number,
  untilSeconds: number,
  minSecondsInside: number,
) {
  const r = await c.query<{
    area_id: string;
    day: string;
    start_hour: number;
    distinct_bikes: string;
    bike_seconds: string;
  }>(
    `WITH m AS (
       SELECT ms.screen_id, ms.minute AT TIME ZONE 'Asia/Kolkata' AS local,
              split_part(split_part(k.key, ':', 2), '@', 1) AS area_id, k.value::int AS secs
         FROM minute_summaries ms, jsonb_each_text(ms.clock_at) k
        WHERE ms.minute >= to_timestamp($2) AND ms.minute < to_timestamp($3) AND k.key LIKE 'inside:%'
     ), h AS (
       SELECT screen_id, area_id,
              (CASE WHEN extract(hour FROM local) < 2 THEN local::date - 1 ELSE local::date END)::text AS day,
              (CASE WHEN extract(hour FROM local) < 2 THEN extract(hour FROM local) + 24
                    ELSE extract(hour FROM local) END)::int AS start_hour,
              sum(secs) AS secs
         FROM m WHERE area_id = ANY($1) GROUP BY 1, 2, 3, 4
     )
     SELECT area_id, day, start_hour,
            count(*) FILTER (WHERE secs >= $4) AS distinct_bikes, sum(secs) AS bike_seconds
       FROM h GROUP BY 1, 2, 3`,
    [areaIds, sinceSeconds, untilSeconds, minSecondsInside],
  );
  return r.rows.map((x) => ({
    areaId: x.area_id,
    date: x.day,
    startHour: x.start_hour,
    distinctBikes: Number(x.distinct_bikes),
    bikeSeconds: Number(x.bike_seconds),
  }));
}

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
  const since = now - (rules.lookbackWeeks + 1) * 7 * 86_400;
  const past = await history(c, areaIds, since, now, rules.minSecondsInside);
  const est = await c.query<{ area_id: string; start_hour: number; bikes: number }>(
    `SELECT DISTINCT ON (area_id, start_hour) area_id, start_hour, bikes FROM area_supply_estimates
      WHERE area_id = ANY($1) ORDER BY area_id, start_hour, version DESC`,
    [areaIds],
  );
  for (const s of slots) {
    const weeks: WeekSupply[] = past
      .filter(
        (p) =>
          p.areaId === s.areaId &&
          p.startHour === s.startHour &&
          weekday(p.date) === weekday(s.date),
      )
      .map((p) => ({ date: p.date, distinctBikes: p.distinctBikes, bikeSeconds: p.bikeSeconds }));
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
