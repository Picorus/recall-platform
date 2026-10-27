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
import { rulesNow } from './rules-cache.js';
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

/** Postgres codes for "two transactions got in each other's way; try again": a deadlock, and a
 * serialization failure. */
const TRY_AGAIN = new Set(['40P01', '40001']);
/** Tries for one upload when it meets another in the database's way. */
export const UPLOAD_TRIES = 3;

/**
 * Stores one upload from one screen. `oldestHeld` is the smallest number the screen still keeps.
 * Uploads from the same screen are handled one at a time (row lock on its inbox).
 *
 * P7.2 (load test): when a new day starts, many uploads at once make the day's first plays and
 * minutes, and the database's new day-pieces (TimescaleDB chunks) can deadlock two of them. Nothing
 * was stored by the loser (its transaction is undone whole), so it is simply tried again.
 */
export async function storeUpload(
  pool: Pool,
  screenId: string,
  batch: readonly Numbered[],
  oldestHeld: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Stored> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await storeUploadOnce(pool, screenId, batch, oldestHeld, now);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (attempt >= UPLOAD_TRIES || typeof code !== 'string' || !TRY_AGAIN.has(code)) throw e;
      // A short, slightly random wait so the two do not meet again at once.
      await new Promise((ok) => setTimeout(ok, 20 * attempt + Math.floor(Math.random() * 30)));
    }
  }
}

/**
 * How far past the next number expected (or the oldest the screen still holds) a report is taken
 * (P7.1): about 10 hours of a screen's reports. A screen sends oldest first, so this never holds a
 * real one back for long; without it, a tampered box could park any number of reports ahead of a
 * gap it never fills, and every later upload of that screen would read them all again.
 */
export const MOST_AHEAD = 5_000;

async function storeUploadOnce(
  pool: Pool,
  screenId: string,
  sent: readonly Numbered[],
  oldestHeld: number,
  now: number,
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
    // Too far ahead: left out, not answered for; the screen sends them again later.
    const proven = Math.min(
      ...sent.flatMap((n) => (Number.isSafeInteger(n.seq) && n.seq > 0 ? [n.seq] : [])),
    );
    const held = Number.isSafeInteger(oldestHeld) ? Math.min(oldestHeld, proven) : proven;
    const from = Math.max(upTo, Number.isFinite(held) ? held - 1 : 0);
    const batch = sent.filter((n) => !Number.isSafeInteger(n.seq) || n.seq <= from + MOST_AHEAD);
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
        : await (async () => {
            const rules = await rulesNow(c);
            return judgePlays(c, screenId, newPlays, rules.areas, now, rules.books);
          })();

    let rejected = 0;
    const seen = new Set<number>();
    // P7.2: every new report of the upload in one statement, then its plays in one (they were one
    // statement each: most of an upload's trips to the database).
    const reports: {
      seq: number;
      kind: string;
      at: number | null;
      body: string;
      why: string | null;
    }[] = [];
    const plays: unknown[][] = [];
    for (const n of batch) {
      if (!isNew(n) || seen.has(n.seq)) continue;
      seen.add(n.seq);
      const j = judged.get(n.seq);
      const problem = problemWith(n) ?? j?.refused;
      if (problem) {
        rejected += 1;
        setAside.add(n.seq);
        reports.push({
          seq: n.seq,
          kind: 'rejected',
          at: null,
          body: JSON.stringify({ raw: rawCopy(n.report) }),
          why: problem,
        });
        continue;
      }
      reports.push({
        seq: n.seq,
        kind: n.report.kind,
        at: n.at,
        body: JSON.stringify(n.report),
        why: null,
      });
      if (n.report.kind === 'play' && j && !j.refused) {
        const p = n.report;
        plays.push([
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
        ]);
      }
    }
    if (reports.length > 0)
      // A set-aside report is stamped with the time it was received (its own time may be junk).
      await c.query(
        `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body, reject_reason)
         SELECT $1, r.seq, r.kind, coalesce(to_timestamp(r.at), now()), r.body, r.why
           FROM unnest($2::bigint[], $3::text[], $4::double precision[], $5::jsonb[], $6::text[])
             AS r (seq, kind, at, body, why)
         ON CONFLICT DO NOTHING`,
        [
          screenId,
          reports.map((r) => r.seq),
          reports.map((r) => r.kind),
          reports.map((r) => r.at),
          reports.map((r) => r.body),
          reports.map((r) => r.why),
        ],
      );
    if (plays.length > 0) {
      const col = (i: number) => plays.map((row) => row[i]);
      await c.query(
        `INSERT INTO plays (screen_id, seq, start_at, key_id, slot, ref, ad_id, length_s, lat_e6,
           lng_e6, accuracy_m, screen_place, cloud_place, counts, line_id, reason, people)
         SELECT $1, p.seq, to_timestamp(p.start_at), p.key_id, p.slot, p.ref, p.ad_id, p.length_s,
                p.lat_e6, p.lng_e6, p.accuracy_m, p.screen_place, p.cloud_place, p.counts,
                p.line_id, p.reason, p.people
           FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[],
                       $8::int[], $9::int[], $10::int[], $11::int[], $12::text[], $13::text[],
                       $14::text[], $15::text[], $16::text[], $17::int[])
             AS p (seq, start_at, key_id, slot, ref, ad_id, length_s, lat_e6, lng_e6, accuracy_m,
                   screen_place, cloud_place, counts, line_id, reason, people)`,
        [screenId, ...Array.from({ length: 16 }, (_, i) => col(i))],
      );
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
