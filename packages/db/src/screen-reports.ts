// Screen uploads into the database (P1.2.5). Uses the same `receive` rules as the simulator, so each
// report is stored exactly once and minute summaries are counted in order, however often a batch is
// sent and in whatever order batches arrive.
import {
  checkReport,
  keptOfRejected,
  receive,
  type Inbox,
  type MinuteSummary,
  type Numbered,
  type Report,
} from '@recall/domain';
import type { Pool } from 'pg';
import { allAreaVersions } from './areas.js';
import { storeCommandResult } from './commands.js';
import { storeFitting } from './fitting.js';
import { heardFrom, storeHealth } from './health.js';
import { judgePlays, type PlayJudgement } from './plays.js';

/** Why a numbered report was set aside instead of stored, or undefined when it is fine. */
function problemWith(n: Numbered): string | undefined {
  if (!Number.isSafeInteger(n.at) || n.at < 0 || n.at >= 2 ** 32) return 'bad time made';
  return checkReport(n.report);
}

/** A short, storable copy of a report that failed its checks, for a person to look at (P1.8.1). */
function rawCopy(report: unknown): string {
  return JSON.stringify(keptOfRejected(report)).replaceAll('\\u0000', '').slice(0, 4000);
}

export interface Stored {
  /** Number to send back to the screen: everything up to here is safe. */
  readonly ack: number;
  /** Minute summaries newly counted by this batch. */
  readonly minutesCounted: number;
  /** Reports in this batch set aside because they failed the checks (they keep their number). */
  readonly rejected: number;
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
  now: number = Math.floor(Date.now() / 1000),
): Promise<Stored> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Work through the limited app role: it can add rows, never edit, delete or switch checks off.
    await c.query('SET LOCAL ROLE recall_app');
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
    const waiting = await c.query<{ seq: string; kind: string; made_at: Date; body: Report }>(
      'SELECT seq, kind, made_at, body FROM screen_reports WHERE screen_id = $1 AND seq > $2',
      [screenId, upTo],
    );
    const setAside = new Set(
      waiting.rows.filter((w) => w.kind === 'rejected').map((w) => Number(w.seq)),
    );
    const ahead = new Map<number, Numbered>(
      waiting.rows.map((r) => [
        Number(r.seq),
        { seq: Number(r.seq), report: r.body, at: Math.floor(r.made_at.getTime() / 1000) },
      ]),
    );
    const inbox: Inbox = { upTo, ahead, lost };
    const result = receive(inbox, batch, oldestHeld);

    // Keep every new report as received (the key ignores repeats). One that fails its checks is
    // kept aside with the reason: it takes its number, so the queue moves on, but it never counts.
    // New plays are judged first (signature, time, overlap, place, line): P1.5.2.
    const isNew = (n: Numbered) => Number.isSafeInteger(n.seq) && n.seq > upTo && !ahead.has(n.seq);
    // The first copy of a number in a batch is the one kept.
    const firstCopies = [
      ...new Map(
        batch
          .filter(isNew)
          .reverse()
          .map((n) => [n.seq, n]),
      ).values(),
    ];
    const newPlays = firstCopies.flatMap((n) =>
      !problemWith(n) && n.report.kind === 'play' ? [{ seq: n.seq, play: n.report }] : [],
    );
    const judged =
      newPlays.length === 0
        ? new Map<number, PlayJudgement>()
        : await judgePlays(c, screenId, newPlays, await allAreaVersions(c), now);

    let rejected = 0;
    const seen = new Set<number>();
    for (const n of batch) {
      if (!isNew(n) || seen.has(n.seq)) continue;
      seen.add(n.seq);
      const j = judged.get(n.seq);
      const problem = problemWith(n) ?? j?.refused;
      if (problem) {
        rejected += 1;
        setAside.add(n.seq);
        await c.query(
          `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body, reject_reason)
           VALUES ($1, $2, 'rejected', now(), $3, $4) ON CONFLICT DO NOTHING`,
          [screenId, n.seq, JSON.stringify({ raw: rawCopy(n.report) }), problem],
        );
        continue;
      }
      await c.query(
        `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
         VALUES ($1, $2, $3, to_timestamp($4), $5) ON CONFLICT DO NOTHING`,
        [screenId, n.seq, n.report.kind, n.at, JSON.stringify(n.report)],
      );
      if (n.report.kind === 'play' && j && !j.refused) {
        const p = n.report;
        await c.query(
          `INSERT INTO plays (screen_id, seq, start_at, key_id, slot, ref, ad_id, length_s, lat_e6,
             lng_e6, accuracy_m, screen_place, cloud_place, counts, line_id, reason, people)
           VALUES ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [
            screenId,
            n.seq,
            p.startAt,
            p.keyId,
            p.slot,
            p.ref,
            p.adId,
            p.lengthS,
            p.latE6,
            p.lngE6,
            p.accuracyM,
            p.place,
            j.cloudPlace,
            j.count.counts,
            j.count.counts === 'no' ? null : j.count.lineId,
            j.count.counts === 'no' ? j.count.reason : null,
            p.people,
          ],
        );
      }
    }
    // P2.11: health reports, in the order they are numbered, and the alerts they decide.
    for (const n of result.accepted) {
      if (setAside.has(n.seq) || n.report.kind !== 'health') continue;
      await storeHealth(c, screenId, n.seq, n.report);
    }
    // P2.12: the box's answers to commands.
    for (const n of result.accepted) {
      if (setAside.has(n.seq) || n.report.kind !== 'command') continue;
      await storeCommandResult(c, screenId, n.seq, n.report);
    }
    // P2.14: fitting checks, with the cloud's verdict.
    for (const n of result.accepted) {
      if (setAside.has(n.seq) || n.report.kind !== 'fitting') continue;
      await storeFitting(c, screenId, n.seq, n.report);
    }
    await heardFrom(c, screenId, now);
    let minutesCounted = 0;
    for (const n of result.accepted) {
      if (setAside.has(n.seq) || n.report.kind !== 'minute') continue;
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
    return { ack: result.ack, minutesCounted, rejected };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Minute summaries stored for a screen between two times (UTC seconds), oldest first. */
export async function minutesOf(
  pool: Pick<Pool, 'query'>,
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
