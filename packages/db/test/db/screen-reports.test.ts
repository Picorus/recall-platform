import {
  acknowledge,
  addSecond,
  dailyTotals,
  EMPTY_MINUTE,
  EMPTY_OUTBOX,
  enqueue,
  flushMinute,
  nextBatch,
  oldestHeld,
  type MinuteBuilder,
  type Numbered,
  type Outbox,
  type Report,
  type Second,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { minutesOf, storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

// Mon 23 Aug 2027, 10:00 India time.
const T = Date.UTC(2027, 7, 23, 4, 30) / 1000;

/** A screen riding for `minutes`: returns its outbox and the reports it made. */
function ride(minutes: number): { box: Outbox; made: Report[] } {
  let b: MinuteBuilder = EMPTY_MINUTE;
  let box = EMPTY_OUTBOX;
  const made: Report[] = [];
  for (let i = 0; i < minutes * 60; i++) {
    const s: Second = {
      t: T + i,
      fix: 'used',
      position: { lat: 17.45, lng: 78.39 + i * 0.00005 },
      place: { kind: 'inside', areaId: 'hyd-madhapur', version: 1 },
      moving: true,
      standby: false,
      clockRuns: true,
    };
    const r = addSecond(b, s);
    b = r.builder;
    box = enqueue(box, r.reports, s.t);
    made.push(...r.reports);
  }
  const last = flushMinute(b);
  return { box: enqueue(box, last, T + minutes * 60), made: [...made, ...last] };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await pool.query<{ n: string }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}

describe('screen uploads in the database', () => {
  it('lost, repeated and out-of-order uploads: every report stored once, every minute counted once', async () => {
    const { box: start, made } = ride(30);
    let box = start;
    let turn = 0;
    const sent: Numbered[] = [];
    while (box.waiting.length > 0 && turn < 500) {
      turn += 1;
      let batch = [...nextBatch(box, 7)];
      if (turn % 3 === 0) batch = [...sent.slice(-4), ...batch]; // repeats
      if (turn % 4 === 0) batch.reverse(); // out of order
      sent.push(...batch);
      if (turn % 5 === 0) continue; // upload lost on the way
      const r = await storeUpload(pool, 'scr-1', batch, oldestHeld(box));
      if (turn % 7 !== 0) box = acknowledge(box, r.ack); // reply lost on the way back
    }
    expect(box.waiting).toHaveLength(0);
    expect(
      await count('SELECT count(*) AS n FROM screen_reports WHERE screen_id = $1', ['scr-1']),
    ).toBe(made.length);
    const minutes = made.filter((r) => r.kind === 'minute').length;
    expect(
      await count('SELECT count(*) AS n FROM minute_summaries WHERE screen_id = $1', ['scr-1']),
    ).toBe(minutes);
    const days = dailyTotals(await minutesOf(pool, 'scr-1', T - 60, T + 3600));
    expect(days.get('2027-08-23')?.clockSeconds).toBe(30 * 60);
  });

  it('the same upload arriving twice at the same moment is still stored once', async () => {
    const { box, made } = ride(3);
    const batch = nextBatch(box, 100);
    await Promise.all([
      storeUpload(pool, 'scr-2', batch, oldestHeld(box)),
      storeUpload(pool, 'scr-2', batch, oldestHeld(box)),
      storeUpload(pool, 'scr-2', batch, oldestHeld(box)),
    ]);
    expect(
      await count('SELECT count(*) AS n FROM screen_reports WHERE screen_id = $1', ['scr-2']),
    ).toBe(made.length);
    expect(
      await count('SELECT count(*) AS n FROM minute_summaries WHERE screen_id = $1', ['scr-2']),
    ).toBe(made.filter((r) => r.kind === 'minute').length);
  });

  it('a wrong "oldest held" cannot make the database skip reports', async () => {
    const { box } = ride(2);
    const r = await storeUpload(pool, 'scr-3', nextBatch(box, 100), 1_000_000);
    expect(r.ack).toBe(box.waiting.length);
    expect(
      await count('SELECT lost AS n FROM screen_inboxes WHERE screen_id = $1', ['scr-3']),
    ).toBe(0);
  });

  it('stored reports can never be edited or deleted, and the inbox never moves back', async () => {
    await expect(
      pool.query("UPDATE screen_reports SET kind = 'live' WHERE screen_id = 'scr-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM minute_summaries WHERE screen_id = 'scr-1'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("UPDATE screen_inboxes SET up_to = 0 WHERE screen_id = 'scr-1'"),
    ).rejects.toThrow(/forward/);
  });
});
