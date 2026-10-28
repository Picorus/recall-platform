// P7.8.3: a POC brand's numbers for a month, for its portal and our staff: plays, different bikes,
// bike-hours, the busiest streets and people (an estimate shown as a range, never billed, hard rule
// 7). Read only; nothing here touches money.
import type { MapsAdapter } from '@recall/adapters';
import {
  busiestStreets,
  DEFAULT_PEOPLE_RULES,
  isMonth,
  peopleEstimate,
  pocRef,
  type PeopleEstimate,
  type Street,
} from '@recall/domain';
import type { PoolClient } from 'pg';
import { COUNTED, FROM_PLAYS } from './poc.js';

type Q = Pick<PoolClient, 'query'>;

export interface PocReportDay {
  readonly day: string;
  readonly plays: number;
  readonly bikes: number;
  readonly bikeHours: number;
}

export interface PocReport {
  readonly month: string;
  readonly ref: string;
  readonly plays: number;
  readonly bikes: number;
  readonly bikeHours: number;
  readonly days: readonly PocReportDay[];
  /** Every month of its commitment, side by side. */
  readonly months: readonly { month: string; plays: number; bikes: number; bikeHours: number }[];
  readonly streets: readonly Street[];
  /** People who may have seen the ads: an estimate shown as a range, never billed (P1.8). */
  readonly people: PeopleEstimate;
}

/**
 * A POC brand's numbers for one month (P7.8.3): plays, different bikes, bike-hours (a bike with at
 * least one counted play in an India hour), by business day; the busiest streets (when a maps
 * service is set up); people as an approximate range (never billed). Nothing is promised, so there is
 * no target to compare with. Undefined when the brand has no such month.
 */
export async function pocReport(
  c: Q,
  brandId: string,
  month: string,
  maps?: Pick<MapsAdapter, 'streetAt'>,
): Promise<PocReport | undefined> {
  if (!isMonth(month)) return undefined;
  const all = await c.query<{ month: string }>(
    'SELECT month FROM poc_months WHERE brand_id = $1 ORDER BY month',
    [brandId],
  );
  if (!all.rows.some((x) => x.month === month)) return undefined;
  const ref = pocRef(brandId, month);
  const days = await c.query<{ day: string; plays: string; bikes: string; bike_hours: string }>(
    `SELECT ((p.start_at AT TIME ZONE 'Asia/Kolkata') - interval '2 hours')::date::text AS day,
            count(*) AS plays, count(DISTINCT p.screen_id) AS bikes,
            count(DISTINCT (p.screen_id, floor((extract(epoch FROM p.start_at) - 1800) / 3600)))
              AS bike_hours
       ${FROM_PLAYS} WHERE p.line_id = $1 AND ${COUNTED}
      GROUP BY 1 ORDER BY 1`,
    [ref],
  );
  const per = await c.query<{
    line_id: string;
    plays: string;
    bikes: string;
    bike_hours: string;
    people: string;
  }>(
    `SELECT p.line_id, count(*) AS plays, count(DISTINCT p.screen_id) AS bikes,
            count(DISTINCT (p.screen_id, floor((extract(epoch FROM p.start_at) - 1800) / 3600)))
              AS bike_hours,
            coalesce(sum(least(p.people, $2)), 0) AS people
       ${FROM_PLAYS} WHERE p.line_id = ANY($1) AND ${COUNTED}
      GROUP BY p.line_id`,
    [all.rows.map((x) => pocRef(brandId, x.month)), DEFAULT_PEOPLE_RULES.perPlayMax],
  );
  const mine = per.rows.find((x) => x.line_id === ref);
  let streets: Street[] = [];
  if (maps) {
    // Plays per small square (about 220 m), the busiest looked up by name.
    const cells = await c.query<{ gy: string; gx: string; n: string }>(
      `SELECT round(p.lat_e6 / 2000.0) AS gy, round(p.lng_e6 / 2000.0) AS gx, count(*) AS n
         ${FROM_PLAYS} WHERE p.line_id = $1 AND ${COUNTED}
        GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2 LIMIT 40`,
      [ref],
    );
    const heat = cells.rows.map((x) => ({
      cell: `${x.gy}:${x.gx}`,
      lat: (Number(x.gy) * 2000) / 1e6,
      lng: (Number(x.gx) * 2000) / 1e6,
      plays: Number(x.n),
    }));
    // All at once, each given at most 3 seconds (a slow maps service never holds up the page).
    const within = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<undefined>((ok) => setTimeout(() => ok(undefined), 3_000).unref()),
      ]);
    const found = await Promise.all(
      heat.map((h) => within(maps.streetAt(h.lat, h.lng)).catch(() => undefined)),
    );
    const names = new Map<string, string>();
    heat.forEach((h, i) => {
      const name = found[i];
      if (name) names.set(h.cell, name);
    });
    streets = busiestStreets(heat, names, 5);
  }
  return {
    month,
    ref,
    plays: Number(mine?.plays ?? 0),
    bikes: Number(mine?.bikes ?? 0),
    bikeHours: Number(mine?.bike_hours ?? 0),
    days: days.rows.map((d) => ({
      day: d.day,
      plays: Number(d.plays),
      bikes: Number(d.bikes),
      bikeHours: Number(d.bike_hours),
    })),
    months: all.rows.map((x) => {
      const p = per.rows.find((y) => y.line_id === pocRef(brandId, x.month));
      return {
        month: x.month,
        plays: Number(p?.plays ?? 0),
        bikes: Number(p?.bikes ?? 0),
        bikeHours: Number(p?.bike_hours ?? 0),
      };
    }),
    streets,
    people: peopleEstimate(Number(mine?.people ?? 0)),
  };
}
