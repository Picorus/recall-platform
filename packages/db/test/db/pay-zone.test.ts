// P1.7.5 review (S3): the pay zone at each moment. Minutes before the split by business mode keep
// the result they had then; a zone saved later never changes hours already worked.
import { countedSecondsOf, launchAreas, type MinuteSummary } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { payZoneAt } from '../../src/pay-zone.js';
import { saveSetting } from '../../src/settings.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
}, 60_000);
afterAll(async () => db.drop());

/** A minute ridden outside every area, the box marking it all inside its POC circle. */
const outside = (minute: number): MinuteSummary => ({
  kind: 'minute',
  minute,
  secondsAt: { outside: 60 },
  clockSeconds: 60,
  clockAt: { outside: 60 },
  payClockSeconds: 60,
  movingSeconds: 60,
  distanceM: 400,
  plays: 0,
  people: 0,
});

describe('the pay zone through time (S3)', () => {
  it('before the split a minute counts as it did then; after it, by the new zones', async () => {
    const r = await pool.query<{ at: string }>(
      'SELECT extract(epoch FROM at)::bigint AS at FROM pay_zone_split',
    );
    const split = Number(r.rows[0]?.at);
    expect(split).toBeGreaterThan(0);
    const zoneAt = await payZoneAt(pool);
    // Regular business (no switch): before the split the box's circle counted, as it did then.
    const before = split - 86_400;
    expect(countedSecondsOf(outside(before), zoneAt(before))).toBe(60);
    // After it, outside every area counts nothing.
    expect(countedSecondsOf(outside(split + 60), zoneAt(split + 60))).toBe(0);
  });

  it('saving a zone never changes hours already worked', async () => {
    await pause(1_100);
    const worked = Math.floor(Date.now() / 1000);
    const inMadhapur: MinuteSummary = {
      ...outside(worked),
      clockAt: { 'inside:hyd-madhapur@1': 60 },
    };
    const was = countedSecondsOf(inMadhapur, (await payZoneAt(pool))(worked));
    expect(was).toBe(60);
    await pause(1_100);
    await saveSetting(
      pool,
      'regularZone',
      { kind: 'areas', areaIds: ['hyd-kondapur'], withEdge: false },
      SUPER,
      'only Kondapur for now',
      0,
    );
    const zoneAt = await payZoneAt(pool);
    expect(countedSecondsOf(inMadhapur, zoneAt(worked))).toBe(was);
    const later = worked + 3600;
    expect(countedSecondsOf({ ...inMadhapur, minute: later }, zoneAt(later))).toBe(0);
    // And a minute from before the split still counts as it did then.
    expect(countedSecondsOf(outside(worked - 400 * 86_400), zoneAt(worked - 400 * 86_400))).toBe(
      60,
    );
  });
});
