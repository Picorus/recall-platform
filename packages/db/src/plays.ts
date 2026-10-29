// P1.5 in the database: screens' keys, checking each play as it arrives, and per-line totals.
import { createPublicKey, verify } from 'node:crypto';
import {
  DEFAULT_PLAY_RULES,
  isoAt,
  isPocRef,
  judgePlay,
  lineIdOf,
  lineStartsAt,
  countedPlays,
  lineTotals,
  playBytes,
  priceBookAt,
  type AreaVersion,
  type CountedPlay,
  type LineForPlays,
  type LineTotals,
  type PlayCount,
  type PlayRefusal,
  type PlayRules,
  type PlayReport,
  type PriceBook,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { priceBooks } from './bookings.js';
import { pocJudge } from './poc.js';

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
  /** Plays it signed from this moment (UTC seconds) on are refused: when the screen was lost. */
  playsUntil: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await inTransaction(pool, (c) =>
    c.query(
      `INSERT INTO screen_key_revocations (screen_id, key_id, revoked_by, reason, plays_until)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [screenId, keyId, revokedBy, reason, playsUntil],
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

/** Booking states in which a line's plays count: its ads were approved and it was not called off. */
export const COUNTING = ['ads-approved', 'running', 'done', 'report-sent'];

interface LineInfo {
  readonly line: LineForPlays;
  readonly state: string;
  /** The price book it was sold on: its play rules count its plays. */
  readonly priceBookVersion: number;
}

/** The ads a booking runs: its latest choice, fixed once it starts (P7.1: a play of another ad,
 * one it chose earlier and replaced included, never counts). */
async function bookingAds(c: Q, bookingId: string): Promise<string[]> {
  const r = await c.query<{ ad_ids: string[] }>(
    `SELECT ad_ids FROM booking_ad_sets WHERE booking_id = $1 ORDER BY version DESC LIMIT 1`,
    [bookingId],
  );
  return r.rows[0]?.ad_ids ?? [];
}

/** A booking line named by `lineId` exactly as `lineIdOf` writes it ("booking/area/day/hour"). */
async function lineInfo(c: Q, lineId: string): Promise<LineInfo | undefined> {
  const parts = lineId.split('/');
  if (parts.length !== 4) return undefined;
  const [bookingId, areaId, day, hour] = parts as [string, string, string, string];
  const startHour = Number(hour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(startHour)) return undefined;
  // One spelling only, so a line's plays are never split between "…/8" and "…/08".
  if (lineIdOf(bookingId, areaId, day, startHour) !== lineId) return undefined;
  const r = await c.query<{ plays: number; state: string; version: number }>(
    `SELECT bl.plays, b.price_book_version AS version,
            (SELECT state FROM booking_events e WHERE e.booking_id = bl.booking_id
              ORDER BY seq DESC LIMIT 1) AS state
       FROM booking_lines bl JOIN bookings b USING (booking_id)
      WHERE bl.booking_id = $1 AND bl.area_id = $2 AND bl.day = $3::date AND bl.start_hour = $4`,
    [bookingId, areaId, day, startHour],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const startsAt = lineStartsAt({ date: day, startHour });
  return {
    line: {
      lineId,
      areaId,
      startsAt,
      endsAt: startsAt + 3600,
      plays: row.plays,
      ads: await bookingAds(c, bookingId),
    },
    state: row.state,
    priceBookVersion: row.version,
  };
}

/** A make-up ("<line id>#1" or "#2"), with its booking's state and price book (P1.6). */
async function makeUpInfo(c: Q, makeUpId: string): Promise<LineInfo | undefined> {
  const r = await c.query<{
    area_id: string;
    from: string;
    until: string;
    plays: number;
    state: string;
    version: number;
    booking_id: string;
  }>(
    `SELECT m.area_id, m.booking_id, extract(epoch FROM m.window_from)::bigint AS from,
            extract(epoch FROM m.window_until)::bigint AS until, m.plays,
            b.price_book_version AS version,
            (SELECT state FROM booking_events e WHERE e.booking_id = m.booking_id
              ORDER BY seq DESC LIMIT 1) AS state
       FROM make_ups m JOIN bookings b USING (booking_id) WHERE m.make_up_id = $1`,
    [makeUpId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    line: {
      lineId: makeUpId,
      areaId: row.area_id,
      startsAt: Number(row.from),
      endsAt: Number(row.until),
      plays: row.plays,
      ads: await bookingAds(c, row.booking_id),
    },
    state: row.state,
    priceBookVersion: row.version,
  };
}

/** What a play reference names: a booking line or a make-up of one. */
const targetInfo = (c: Q, ref: string) =>
  /#[12]$/.test(ref) ? makeUpInfo(c, ref) : lineInfo(c, ref);

/** Play rules of a price book version (or those in force at a moment). */
function rulesOf(books: readonly PriceBook[], at: { version: number } | { time: number }) {
  const book =
    'version' in at
      ? books.find((b) => b.version === at.version)
      : priceBookAt(books, isoAt(at.time));
  return book?.plays ?? DEFAULT_PLAY_RULES;
}

export type PlayJudgement =
  | { readonly refused: PlayRefusal }
  | { readonly refused?: undefined; readonly count: PlayCount; readonly cloudPlace: string };

/**
 * Judges the new plays of one upload, in report order (P1.5.2): signature against the screen's
 * keys, no two plays within one spot (against stored plays and earlier ones in the batch), the place
 * re-checked against the areas, and the booking line. A play is judged by the rules in force when
 * it was played.
 */
export async function judgePlays(
  c: Q,
  screenId: string,
  plays: readonly { seq: number; play: PlayReport }[],
  areas: readonly AreaVersion[],
  now: number,
  /** The price books, when the caller has them (P7.2: read once, not for every upload). */
  knownBooks?: readonly PriceBook[],
): Promise<Map<number, PlayJudgement>> {
  const out = new Map<number, PlayJudgement>();
  if (plays.length === 0) return out;
  const books = knownBooks ?? (await priceBooks(c));
  const keys = await c.query<{
    key_id: string;
    public_key: string;
    until: string | null;
    revoked: string | null;
  }>(
    `SELECT k.key_id, k.public_key, extract(epoch FROM r.plays_until)::bigint AS until,
            extract(epoch FROM r.revoked_at)::bigint AS revoked
       FROM screen_keys k LEFT JOIN screen_key_revocations r USING (screen_id, key_id)
      WHERE k.screen_id = $1`,
    [screenId],
  );
  const window = 60; // longer than any spot
  const from = plays.reduce((m, p) => Math.min(m, p.play.startAt), Number.POSITIVE_INFINITY);
  const to = plays.reduce((m, p) => Math.max(m, p.play.startAt), 0);
  const near = await c.query<{ t: string }>(
    `SELECT extract(epoch FROM start_at)::bigint AS t FROM plays
      WHERE screen_id = $1 AND start_at > to_timestamp($2) AND start_at < to_timestamp($3)`,
    [screenId, from - window, to + window],
  );
  const taken = near.rows.map((r) => Number(r.t));
  const lines = new Map<string, LineInfo | undefined>();
  // P7.8: plays naming a POC month ("poc/<brand>/<YYYY-MM>"), at most 5 a brand a bike-hour.
  const poc = pocJudge(c, screenId);
  for (const { seq, play } of [...plays].sort((a, b) => a.seq - b.seq)) {
    const rules = rulesOf(books, { time: play.startAt });
    // A revoked key still covers plays from before the moment it was given up (counted only if
    // they arrived before it was revoked: playsOf).
    const key = keys.rows.find(
      (k) => k.key_id === play.keyId && (k.until === null || play.startAt < Number(k.until)),
    );
    const signature = !key
      ? 'unknown key'
      : signatureOk(key.public_key, playBytes(screenId, seq, play), play.sig)
        ? 'ok'
        : 'bad';
    // Brand plays name a booking line or (on a spare bike) a make-up; make-up plays a make-up.
    const named =
      (play.slot === 'brand' && (!play.ref.includes('#') || /#[12]$/.test(play.ref))) ||
      (play.slot === 'make-up' && /#[12]$/.test(play.ref));
    if (named && !lines.has(play.ref)) lines.set(play.ref, await targetInfo(c, play.ref));
    const info = named ? lines.get(play.ref) : undefined;
    const j = judgePlay(
      play,
      {
        receivedAt: now,
        signature,
        neighbours: taken.filter((t) => Math.abs(t - play.startAt) < rules.spotSeconds),
        areas,
        line: info && COUNTING.includes(info.state) ? info.line : undefined,
        ...(isPocRef(play.ref) && signature === 'ok'
          ? { poc: await poc.context(play.ref, play.startAt) }
          : {}),
      },
      rules,
    );
    out.set(seq, j);
    // A play signed with a key given up before now never counts (playsOf), so it must not use up
    // the brand's 5 a bike-hour either.
    const revokedBefore = key?.revoked != null && Number(key.revoked) <= now;
    if (!j.refused && j.count.counts !== 'no' && isPocRef(play.ref) && !revokedBefore)
      poc.counted(play.ref, play.startAt);
    if (!j.refused) taken.push(play.startAt);
  }
  return out;
}

/** A stored play that may count, with where it started (for heat maps, P1.9). */
export interface StoredPlay extends CountedPlay {
  readonly latE6: number;
  readonly lngE6: number;
}

/** The stored plays of a line or make-up that may count, and the rules it was sold on. */
async function playsOf(
  pool: Pick<Pool, 'query'>,
  lineId: string,
  books?: readonly PriceBook[],
): Promise<{ promised: number; plays: StoredPlay[]; rules: PlayRules }> {
  const info = await targetInfo(pool, lineId);
  const r = await pool.query<{
    screen_id: string;
    t: string;
    counts: 'inside' | 'edge';
    people: number;
    lat_e6: number;
    lng_e6: number;
  }>(
    `SELECT p.screen_id, extract(epoch FROM p.start_at)::bigint AS t, p.counts, p.people,
            p.lat_e6, p.lng_e6
       FROM plays p
       LEFT JOIN screen_key_revocations r ON r.screen_id = p.screen_id AND r.key_id = p.key_id
      -- A revoked key's plays: from before it was given up, and in before it was revoked (after
      -- that, whoever holds the key could sign any start time, P7.1). Both times are the database's.
      WHERE p.line_id = $1 AND p.counts <> 'no'
        AND (r.key_id IS NULL OR (p.start_at < r.plays_until AND p.received_at < r.revoked_at))`,
    [lineId],
  );
  return {
    promised: info?.line.plays ?? 0,
    plays: r.rows.map((x) => ({
      screenId: x.screen_id,
      startAt: Number(x.t),
      counts: x.counts,
      people: x.people,
      latE6: x.lat_e6,
      lngE6: x.lng_e6,
    })),
    rules: info
      ? rulesOf(books ?? (await priceBooks(pool)), { version: info.priceBookVersion })
      : DEFAULT_PLAY_RULES,
  };
}

/**
 * Totals for one booking line, or one make-up, from its stored plays (P1.5.3–4), by the rules of
 * the price book it was sold on, so they never change when prices or rules change later. Plays
 * signed with a key after it was given up are left out.
 */
export async function lineTotalsFor(
  pool: Pick<Pool, 'query'>,
  lineId: string,
  /** Price books, when the caller has them already. */
  books?: readonly PriceBook[],
): Promise<LineTotals> {
  const x = await playsOf(pool, lineId, books);
  return lineTotals(x.promised, x.plays, x.rules);
}

/** The plays that count for a line or make-up (which screen, when), by the same rules. */
export async function countedPlaysFor(
  pool: Pick<Pool, 'query'>,
  lineId: string,
  books?: readonly PriceBook[],
): Promise<StoredPlay[]> {
  const x = await playsOf(pool, lineId, books);
  return countedPlays(x.promised, x.plays, x.rules);
}
