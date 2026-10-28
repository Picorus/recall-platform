// The demo's bikes, live: each screen rides the real roads of west Hyderabad (the fleet simulator's
// bikes) and every 30 seconds sends what a real box sends, through the gateway's own handling: where
// it is, the plays it made (a brand's ad when it is inside an area with a campaign running this hour,
// RECALL's own ad elsewhere), and a summary for each minute. The staff fleet map, Today and Delivery
// pages fill as they would with the real fleet.
import { COUNTING, recordHello } from '@recall/db';
import {
  lineIdOf,
  locate,
  placeKey,
  uploadText,
  type AreaVersion,
  type Numbered,
} from '@recall/domain';
import { handleUp, LineMemory } from '@recall/gateway';
import {
  defaultRoads,
  NORMAL_HABITS,
  newBike,
  seeded,
  tick,
  truthOf,
  type Bike,
} from '@recall/simulator';
import type pg from 'pg';
import { signedPlay, type DemoScreen } from './screens.js';

const SEND_EVERY = 30;

/** Lines running now, by area: their line id and their booking's ads. */
async function runningNow(pool: pg.Pool, now: number) {
  const r = await pool.query<{
    booking_id: string;
    area_id: string;
    day: string;
    start_hour: number;
    ad_ids: string[];
  }>(
    `SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, s.ad_ids
       FROM booking_lines bl
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                      ORDER BY seq DESC LIMIT 1) st ON true
       JOIN LATERAL (SELECT ad_ids FROM booking_ad_sets a WHERE a.booking_id = bl.booking_id
                      ORDER BY version DESC LIMIT 1) s ON true
      WHERE st.state = ANY($1)
        AND to_timestamp($2) >= (bl.day::timestamp + make_interval(hours => bl.start_hour)) AT TIME ZONE 'Asia/Kolkata'
        AND to_timestamp($2) < (bl.day::timestamp + make_interval(hours => bl.start_hour + 1)) AT TIME ZONE 'Asia/Kolkata'`,
    [COUNTING, now],
  );
  const out = new Map<string, { lineId: string; ads: string[] }[]>();
  for (const x of r.rows)
    out.set(x.area_id, [
      ...(out.get(x.area_id) ?? []),
      { lineId: lineIdOf(x.booking_id, x.area_id, x.day, x.start_hour), ads: x.ad_ids },
    ]);
  return out;
}

export interface LiveBikes {
  /** Uploads sent and plays that counted for a brand, since the start. */
  readonly stats: () => { uploads: number; brandPlays: number; bikes: number; failed: number };
  stop(): void;
}

export async function startBikes(
  pool: pg.Pool,
  screens: readonly DemoScreen[],
  areas: readonly AreaVersion[],
  log: (l: string) => void,
  /** The demo's clock (ms). */
  clock: () => number = Date.now,
): Promise<LiveBikes> {
  const roads = defaultRoads();
  const rng = seeded(7);
  const start = Math.floor(clock() / 1000);
  const bikes: Bike[] = screens.map((s) => newBike(s.screenId, roads, NORMAL_HABITS, rng, start));
  const pending: Numbered[][] = screens.map(() => []);
  const moving: number[] = screens.map(() => 0);
  const memory = new LineMemory();
  let running = await runningNow(pool, start);
  let uploads = 0;
  let brandPlays = 0;
  let failed = 0;
  let stopped = false;
  for (const s of screens) await recordHello(pool, s.screenId, '1.4.0-demo', start * 1000, 140);

  const second = async (t: number) => {
    if (t % 60 === 0) running = await runningNow(pool, t);
    const sends: Promise<unknown>[] = [];
    for (const [i, s] of screens.entries()) {
      const b = bikes[i];
      if (!b) continue;
      const next = tick(roads, b, NORMAL_HABITS, rng, t);
      bikes[i] = next;
      const truth = truthOf(roads, next, t);
      if (truth.riding) moving[i] = (moving[i] ?? 0) + 1;
      const place = locate(truth.position, areas);
      const key = placeKey(place);
      const box = pending[i] ?? [];
      // A spot every 15 seconds.
      if (t % 15 === 0 && truth.screenOn) {
        const here = place.kind === 'outside' ? undefined : running.get(place.areaId);
        const line = here?.[i % here.length];
        const body = {
          startAt: t - 15,
          lengthS: 15,
          latE6: Math.round(truth.position.lat * 1e6),
          lngE6: Math.round(truth.position.lng * 1e6),
          accuracyM: 6,
          place: key,
          people: 1 + ((t + i) % 7),
        };
        box.push(
          line
            ? signedPlay(s, {
                slot: 'brand',
                ref: line.lineId,
                adId: line.ads[(t / 15 + i) % line.ads.length] ?? 'ad',
                ...body,
              })
            : signedPlay(s, { slot: 'recall', ref: 'recall', adId: 'recall-own', ...body }),
        );
        if (line) brandPlays += 1;
      }
      // Each minute, what the minute held.
      if (t % 60 === 0) {
        s.seq += 1;
        box.push({
          seq: s.seq,
          at: t,
          report: {
            kind: 'minute',
            minute: t - 60,
            secondsAt: { [key]: 60 },
            clockSeconds: moving[i] ?? 0,
            clockAt: { [key]: moving[i] ?? 0 },
            payClockSeconds: moving[i] ?? 0,
            movingSeconds: moving[i] ?? 0,
            distanceM: (moving[i] ?? 0) * 7,
            plays: 4,
            people: 8,
          },
        });
        moving[i] = 0;
      }
      // Every 30 seconds (each screen at its own moment): where it is, and what it holds.
      if ((t + i) % SEND_EVERY === 0) {
        s.seq += 1;
        box.push({
          seq: s.seq,
          at: t,
          report: {
            kind: 'live',
            t,
            lat: truth.position.lat,
            lng: truth.position.lng,
            place: key,
            moving: truth.riding,
          },
        });
        const batch = box.splice(0, box.length);
        const first = batch[0];
        if (first)
          sends.push(
            handleUp(
              pool,
              `recall/v1/s/${s.screenId}/up/upload`,
              new TextEncoder().encode(uploadText(batch, first.seq)),
              t * 1000,
              memory,
            )
              .then(() => {
                uploads += 1;
              })
              .catch((e: unknown) => {
                failed += 1;
                if (failed % 100 === 1) log(`bikes: an upload failed: ${(e as Error).message}`);
              }),
          );
      }
      pending[i] = box;
    }
    await Promise.all(sends);
  };

  // One second at a time, never two at once (a slow database only slows the bikes down).
  const loop = async () => {
    let t = Math.floor(clock() / 1000);
    while (!stopped) {
      await second(t).catch((e: unknown) => log(`bikes: ${(e as Error).message}`));
      t += 1;
      const wait = t * 1000 - clock();
      if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
      else if (wait < -10_000) t = Math.floor(clock() / 1000); // fell behind: catch up
    }
  };
  void loop();
  log(`bikes: ${screens.length} riding`);
  return {
    stats: () => ({ uploads, brandPlays, bikes: screens.length, failed }),
    stop: () => {
      stopped = true;
    },
  };
}
