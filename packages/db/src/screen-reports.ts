// Screen uploads into the database (P1.2.5). Uses the same `receive` rules as the simulator, so each
// report is stored exactly once and minute summaries are counted in order, however often a batch is
// sent and in whatever order batches arrive.
import {
  receive,
  type Inbox,
  type MinuteSummary,
  type Numbered,
  type Report,
} from '@recall/domain';
import type { Pool } from 'pg';

export interface Stored {
  /** Number to send back to the screen: everything up to here is safe. */
  readonly ack: number;
  /** Minute summaries newly counted by this batch. */
  readonly minutesCounted: number;
}

/**
 * Stores one upload from one screen. `oldestHeld` is the smallest number the screen still keeps.
 * Uploads from the same screen are handled one at a time (row lock on its inbox).
 */
export async function storeUpload(
  pool: Pool,
  screenId: string,
  batch: readonly Numbered[],
  oldestHeld: number,
): Promise<Stored> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      screenId,
    ]);
    const box = await c.query<{ up_to: string; lost: string }>(
      'SELECT up_to, lost FROM screen_inboxes WHERE screen_id = $1 FOR UPDATE',
      [screenId],
    );
    const upTo = Number(box.rows[0]?.up_to ?? 0);
    const lost = Number(box.rows[0]?.lost ?? 0);
    // Reports already stored that arrived ahead of a gap.
    const waiting = await c.query<{ seq: string; made_at: Date; body: Report }>(
      'SELECT seq, made_at, body FROM screen_reports WHERE screen_id = $1 AND seq > $2',
      [screenId, upTo],
    );
    const ahead = new Map<number, Numbered>(
      waiting.rows.map((r) => [
        Number(r.seq),
        { seq: Number(r.seq), report: r.body, at: Math.floor(r.made_at.getTime() / 1000) },
      ]),
    );
    const inbox: Inbox = { upTo, ahead, lost };
    const result = receive(inbox, batch, oldestHeld);

    // Keep every new valid report as received (the key ignores repeats).
    for (const n of batch) {
      if (!Number.isSafeInteger(n.seq) || n.seq <= upTo || ahead.has(n.seq)) continue;
      await c.query(
        `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
         VALUES ($1, $2, $3, to_timestamp($4), $5) ON CONFLICT DO NOTHING`,
        [screenId, n.seq, n.report.kind, n.at, JSON.stringify(n.report)],
      );
    }
    let minutesCounted = 0;
    for (const n of result.accepted) {
      if (n.report.kind !== 'minute') continue;
      const m: MinuteSummary = n.report;
      await c.query(
        `INSERT INTO minute_summaries
           (screen_id, minute, seq, clock_s, pay_clock_s, moving_s, distance_m, plays, people, seconds_at, clock_at)
         VALUES ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          screenId,
          m.minute,
          n.seq,
          m.clockSeconds,
          m.payClockSeconds,
          m.movingSeconds,
          m.distanceM,
          m.plays,
          m.people,
          JSON.stringify(m.secondsAt),
          JSON.stringify(m.clockAt),
        ],
      );
      minutesCounted += 1;
    }
    await c.query(
      'UPDATE screen_inboxes SET up_to = $2, lost = $3, updated_at = now() WHERE screen_id = $1',
      [screenId, result.inbox.upTo, result.inbox.lost],
    );
    await c.query('COMMIT');
    return { ack: result.ack, minutesCounted };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Minute summaries stored for a screen between two times (UTC seconds), oldest first. */
export async function minutesOf(
  pool: Pool,
  screenId: string,
  from: number,
  to: number,
): Promise<MinuteSummary[]> {
  const r = await pool.query<{
    minute: Date;
    clock_s: number;
    pay_clock_s: number;
    moving_s: number;
    distance_m: number;
    plays: number;
    people: number;
    seconds_at: Record<string, number>;
    clock_at: Record<string, number>;
  }>(
    `SELECT minute, clock_s, pay_clock_s, moving_s, distance_m, plays, people, seconds_at, clock_at
       FROM minute_summaries
      WHERE screen_id = $1 AND minute >= to_timestamp($2) AND minute < to_timestamp($3)
      ORDER BY minute, seq`,
    [screenId, from, to],
  );
  return r.rows.map((x) => ({
    kind: 'minute',
    minute: Math.floor(x.minute.getTime() / 1000),
    secondsAt: x.seconds_at,
    clockSeconds: x.clock_s,
    clockAt: x.clock_at,
    payClockSeconds: x.pay_clock_s,
    movingSeconds: x.moving_s,
    distanceM: x.distance_m,
    plays: x.plays,
    people: x.people,
  }));
}
