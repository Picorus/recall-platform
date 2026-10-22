// P1.5 in the database: screens' keys, checking each play as it arrives, and per-line totals.
import { createPublicKey, verify } from 'node:crypto';
import {
  DEFAULT_PLAY_RULES,
  isoAt,
  judgePlay,
  lineStartsAt,
  lineTotals,
  playBytes,
  priceBookAt,
  type AreaVersion,
  type LineForPlays,
  type LineTotals,
  type PlayCount,
  type PlayRefusal,
  type PlayReport,
  type PlayRules,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';

type Q = Pick<PoolClient, 'query'>;

async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE recall_app');
    const out = await work(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Registers a screen's public key (ECDSA P-256, SubjectPublicKeyInfo DER, base64). */
export async function addScreenKey(
  pool: Pool,
  screenId: string,
  keyId: string,
  publicKey: string,
  addedBy: string,
): Promise<void> {
  const k = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new RangeError('A screen key must be ECDSA P-256');
  await inTransaction(pool, (c) =>
    c.query(
      'INSERT INTO screen_keys (screen_id, key_id, public_key, added_by) VALUES ($1, $2, $3, $4)',
      [screenId, keyId, publicKey, addedBy],
    ),
  );
}

/** Revokes a key (a lost or stolen screen): later plays signed with it are refused. */
export async function revokeScreenKey(
  pool: Pool,
  screenId: string,
  keyId: string,
  revokedBy: string,
  reason: string,
): Promise<void> {
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO screen_key_revocations (screen_id, key_id, revoked_by, reason)
       VALUES ($1, $2, $3, $4)`,
      [screenId, keyId, revokedBy, reason],
    ),
  );
}

/** Checks a play's signature (ECDSA P-256 with SHA-256, DER). Never throws. */
export function signatureOk(publicKey: string, bytes: string, sig: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      'sha256',
      Buffer.from(bytes, 'utf8'),
      { key, dsaEncoding: 'der' },
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Booking states in which a line's plays count (sold, not cancelled or forfeited). */
const SOLD = ['paid', 'ads-approved', 'running', 'done', 'report-sent'];

/** A booking line, if `lineId` ("booking/area/day/hour") names one that is sold. */
async function soldLine(c: Q, lineId: string): Promise<LineForPlays | undefined> {
  const parts = lineId.split('/');
  if (parts.length !== 4) return undefined;
  const [bookingId, areaId, day, hour] = parts as [string, string, string, string];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,2}$/.test(hour)) return undefined;
  const r = await c.query<{ plays: number; state: string }>(
    `SELECT bl.plays, (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
                        ORDER BY seq DESC LIMIT 1) AS state
       FROM booking_lines bl
      WHERE bl.booking_id = $1 AND bl.area_id = $2 AND bl.day = $3::date AND bl.start_hour = $4`,
    [bookingId, areaId, day, Number(hour)],
  );
  const row = r.rows[0];
  if (!row || !SOLD.includes(row.state)) return undefined;
  return {
    lineId,
    areaId,
    startsAt: lineStartsAt({ date: day, startHour: Number(hour) }),
    plays: row.plays,
  };
}

/** The play rules in force at `now` (from the price book). */
export async function playRulesAt(c: Q, now: number): Promise<PlayRules> {
  return priceBookAt(await priceBooks(c), isoAt(now))?.plays ?? DEFAULT_PLAY_RULES;
}

export type PlayJudgement =
  | { readonly refused: PlayRefusal }
  | { readonly refused?: undefined; readonly count: PlayCount; readonly cloudPlace: string };

/**
 * Judges the new plays of one upload, in report order (P1.5.2): signature against the screen's
 * keys, time, no two plays within one spot (against stored plays and earlier ones in the batch),
 * the place re-checked against the areas, and the booking line.
 */
export async function judgePlays(
  c: Q,
  screenId: string,
  plays: readonly { seq: number; play: PlayReport }[],
  areas: readonly AreaVersion[],
  now: number,
): Promise<Map<number, PlayJudgement>> {
  const out = new Map<number, PlayJudgement>();
  if (plays.length === 0) return out;
  const rules = await playRulesAt(c, now);
  const keys = await c.query<{ key_id: string; public_key: string; revoked: boolean }>(
    `SELECT k.key_id, k.public_key, r.key_id IS NOT NULL AS revoked
       FROM screen_keys k LEFT JOIN screen_key_revocations r USING (screen_id, key_id)
      WHERE k.screen_id = $1`,
    [screenId],
  );
  const starts = plays.map((p) => p.play.startAt);
  const near = await c.query<{ t: string }>(
    `SELECT extract(epoch FROM start_at)::bigint AS t FROM plays
      WHERE screen_id = $1 AND start_at > to_timestamp($2) AND start_at < to_timestamp($3)`,
    [screenId, Math.min(...starts) - rules.spotSeconds, Math.max(...starts) + rules.spotSeconds],
  );
  const taken = near.rows.map((r) => Number(r.t));
  const lines = new Map<string, LineForPlays | undefined>();
  for (const { seq, play } of [...plays].sort((a, b) => a.seq - b.seq)) {
    const key = keys.rows.find((k) => k.key_id === play.keyId && !k.revoked);
    const signature = !key
      ? 'unknown key'
      : signatureOk(key.public_key, playBytes(screenId, seq, play), play.sig)
        ? 'ok'
        : 'bad';
    if (play.slot === 'brand' && !lines.has(play.ref))
      lines.set(play.ref, await soldLine(c, play.ref));
    const j = judgePlay(
      play,
      {
        receivedAt: now,
        signature,
        neighbours: taken.filter((t) => Math.abs(t - play.startAt) < rules.spotSeconds),
        areas,
        line: play.slot === 'brand' ? lines.get(play.ref) : undefined,
      },
      rules,
    );
    out.set(seq, j);
    if (!j.refused) taken.push(play.startAt);
  }
  return out;
}

/** Totals for one booking line from its stored plays (P1.5.3–4). */
export async function lineTotalsFor(
  pool: Pick<Pool, 'query'>,
  lineId: string,
  now: number,
): Promise<LineTotals> {
  const line = await soldLine(pool, lineId);
  const promised = line?.plays ?? 0;
  const r = await pool.query<{
    screen_id: string;
    t: string;
    counts: 'inside' | 'edge';
    people: number;
  }>(
    `SELECT screen_id, extract(epoch FROM start_at)::bigint AS t, counts, people FROM plays
      WHERE line_id = $1 AND counts <> 'no'`,
    [lineId],
  );
  return lineTotals(
    promised,
    r.rows.map((x) => ({
      screenId: x.screen_id,
      startAt: Number(x.t),
      counts: x.counts,
      people: x.people,
    })),
    await playRulesAt(pool, now),
  );
}
