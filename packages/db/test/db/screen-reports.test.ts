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

describe('review fixes', () => {
  const good = (seq: number, minute: number): Numbered => ({
    seq,
    at: minute + 60,
    report: {
      kind: 'minute',
      minute,
      secondsAt: { 'inside:hyd-madhapur@1': 60 },
      clockSeconds: 60,
      clockAt: { 'inside:hyd-madhapur@1': 60 },
      payClockSeconds: 60,
      movingSeconds: 60,
      distanceM: 300,
      plays: 0,
      people: 0,
    },
  });

  it('one bad report is set aside with its reason and never blocks the screen', async () => {
    const bad = {
      ...good(3, T + 120),
      report: { ...good(3, T + 120).report, clockSeconds: 61 },
    } as Numbered;
    const first = await storeUpload(pool, 'scr-bad', [good(1, T), bad], 1);
    expect(first).toMatchObject({ ack: 1, minutesCounted: 1, rejected: 1 });
    // Seq 2 arrives later: the queue moves past the bad one and later minutes still count.
    const second = await storeUpload(pool, 'scr-bad', [good(2, T + 60), good(4, T + 180)], 2);
    expect(second).toMatchObject({ ack: 4, minutesCounted: 2 });
    const r = await pool.query<{ reject_reason: string }>(
      "SELECT reject_reason FROM screen_reports WHERE screen_id = 'scr-bad' AND kind = 'rejected'",
    );
    expect(r.rows.map((x) => x.reject_reason)).toEqual(['clock seconds out of range']);
  });

  it('nonsense in the same batch (unknown kind, bad time, null characters) is set aside too', async () => {
    const batch = [
      { seq: 1, at: T, report: { kind: 'foo' } },
      { seq: 2, at: Number.NaN, report: good(2, T).report },
      { seq: 3, at: T, report: { ...good(3, T).report, secondsAt: { 'a\u0000': 60 } } },
      good(4, T + 60),
    ] as unknown as Numbered[];
    expect(await storeUpload(pool, 'scr-junk', batch, 1)).toMatchObject({
      ack: 4,
      minutesCounted: 1,
      rejected: 3,
    });
  });

  it('three summaries claiming the same minute a second apart: only a whole minute counts', async () => {
    const batch = [
      good(1, T),
      { ...good(2, T), report: { ...good(2, T).report, minute: T + 1 } },
    ] as Numbered[];
    expect(await storeUpload(pool, 'scr-dup', batch, 1)).toMatchObject({
      minutesCounted: 1,
      rejected: 1,
    });
  });

  it('every move of an inbox is logged with who and when', async () => {
    const r = await pool.query<{ up_to_from: string; up_to_to: string; changed_by: string }>(
      "SELECT up_to_from, up_to_to, changed_by FROM screen_inbox_changes WHERE screen_id = 'scr-bad' ORDER BY changed_at",
    );
    expect(r.rows.map((x) => [Number(x.up_to_from), Number(x.up_to_to), x.changed_by])).toEqual([
      [0, 1, 'recall_app'],
      [1, 4, 'recall_app'],
    ]);
  });

  it('through the app role nothing can be wiped or switched off', async () => {
    const c = await pool.connect();
    try {
      await c.query('SET ROLE recall_app');
      for (const sql of [
        'TRUNCATE minute_summaries',
        "SELECT drop_chunks('minute_summaries', now() + interval '1 year')",
        'ALTER TABLE minute_summaries DISABLE TRIGGER USER',
        'DROP TABLE screen_reports',
        "DELETE FROM screen_reports WHERE screen_id = 'scr-1'",
        "UPDATE screen_reports SET body = '{}' WHERE screen_id = 'scr-1'",
      ]) {
        await expect(c.query(sql), sql).rejects.toThrow();
      }
    } finally {
      await c.query('RESET ROLE');
      c.release();
    }
    // Even the owner cannot empty the minute table.
    await expect(pool.query('TRUNCATE minute_summaries')).rejects.toThrow(/append-only/);
  });
});
