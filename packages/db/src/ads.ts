// P3.9.1 in the database: ads uploaded for a brand (checked automatically, stored by fingerprint)
// and which of them each booking runs.
import { fileKey, type FileStore } from '@recall/adapters';
import {
  adFacts,
  checkAd,
  DEFAULT_SPOT_RULES,
  isoAt,
  priceBookAt,
  worst,
  type Actor,
  type AdCheck,
  type AdKind,
  type ReviewDecision,
  type CheckOutcome,
} from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { bookingState, moveBooking, priceBooks, StepRace } from './bookings.js';
import { findAccount } from './brands.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const mbText = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

export interface Ad {
  readonly adId: string;
  readonly brandId: string;
  readonly name: string;
  readonly fileKey: string;
  readonly bytes: number;
  readonly kind: AdKind | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
  readonly codec: string | null;
  readonly checks: readonly AdCheck[];
  readonly outcome: CheckOutcome;
  readonly uploadedBy: string;
  readonly uploadedAt: number;
  /** The Ad review decision (P3.9.2), or null while it waits. */
  readonly review: AdReview | null;
}

export interface AdReview {
  readonly decision: ReviewDecision;
  readonly reason: string | null;
  readonly by: string;
  readonly at: number;
}

const CONTENT_TYPE: Record<AdKind, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

interface AdRow {
  ad_id: string;
  brand_id: string;
  name: string;
  file_key: string;
  bytes: string;
  kind: AdKind | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  codec: string | null;
  checks: AdCheck[];
  outcome: CheckOutcome;
  uploaded_by: string;
  uploaded_at: Date;
  r_decision?: ReviewDecision | null;
  r_reason?: string | null;
  r_by?: string | null;
  r_at?: Date | null;
}
/** An ad with its review, if any. */
const AD_SELECT = `SELECT a.*, r.decision AS r_decision, r.reason AS r_reason,
                          r.reviewed_by AS r_by, r.reviewed_at AS r_at
                     FROM ads a LEFT JOIN ad_reviews r USING (ad_id)`;
const toAd = (r: AdRow): Ad => ({
  adId: r.ad_id,
  brandId: r.brand_id,
  name: r.name,
  fileKey: r.file_key,
  bytes: Number(r.bytes),
  kind: r.kind,
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms,
  codec: r.codec,
  checks: r.checks,
  outcome: r.outcome,
  uploadedBy: r.uploaded_by,
  uploadedAt: secs(r.uploaded_at),
  review:
    r.r_decision && r.r_by && r.r_at
      ? { decision: r.r_decision, reason: r.r_reason ?? null, by: r.r_by, at: secs(r.r_at) }
      : null,
});

/**
 * Takes an uploaded ad for a brand: reads what the file really is, runs the automatic checks (the
 * rules in force), stores it by fingerprint and records it. A file that fails a check is still
 * recorded (so staff can see why) but can never be approved or run. A file that is not a picture or
 * a video at all is refused outright and not stored.
 */
export async function uploadAd(
  pool: Pool,
  store: FileStore,
  a: { brandId: string; name: string; data: Uint8Array; by: string },
  now: number,
): Promise<Ad> {
  const brand = await findAccount(pool, a.brandId);
  if (!brand || brand.kind !== 'brand') throw new Refusal(`No brand ${a.brandId}`);
  if (!brand.active) throw new Refusal(`${brand.name} is closed`);
  const name = a.name.trim();
  if (name.length < 1 || name.length > 80)
    throw new Refusal('Give the ad a name (1 to 80 characters)');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw new Refusal('The ad name has a character that is not allowed');
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  if (!book) throw new Refusal('No price book in force');
  const facts = adFacts(a.data);
  const checks = checkAd(facts, book.ads);
  if (facts.kind === null) throw new Refusal('Not a picture (PNG, JPEG, WebP) or an MP4 video');
  // Too large is refused outright: never stored (a failed check would keep the file).
  const max = facts.kind === 'mp4' ? book.ads.maxVideoBytes : book.ads.maxPictureBytes;
  if (facts.bytes > max)
    throw new Refusal(`The file is ${mbText(facts.bytes)}: at most ${mbText(max)}`);
  const kind = facts.kind;
  const key = fileKey(a.data);
  const adId = `AD-${randomBytes(5).toString('hex').toUpperCase()}`;
  // The row first, then the file, in one transaction: if either fails, neither is kept (a file
  // stored by an upload whose row failed would be found by nothing). A file stored just before a
  // failed commit is harmless: it is kept by fingerprint and the next upload of it reuses it.
  const r = await inTransaction(pool, async (c) => {
    const row = await c.query<AdRow>(
      `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, width, height, duration_ms,
                        codec, checks, outcome, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14))
       RETURNING *`,
      [
        adId,
        a.brandId,
        name,
        key,
        facts.bytes,
        facts.kind,
        facts.width,
        facts.height,
        facts.durationMs,
        facts.codec,
        JSON.stringify(checks),
        worst(checks),
        a.by,
        now,
      ],
    );
    const stored = await store.put(a.data, CONTENT_TYPE[kind]);
    if (stored.key !== key) throw new Error('the file store keyed the file differently');
    return row;
  });
  const row = r.rows[0];
  if (!row) throw new Error('ad not saved');
  return toAd(row);
}

export async function adById(pool: Q, adId: string): Promise<Ad | undefined> {
  const r = await pool.query<AdRow>(`${AD_SELECT} WHERE a.ad_id = $1`, [adId]);
  return r.rows[0] ? toAd(r.rows[0]) : undefined;
}

/** These ads (any order). */
export async function adsByIds(pool: Q, adIds: readonly string[]): Promise<Ad[]> {
  if (adIds.length === 0) return [];
  const r = await pool.query<AdRow>(`${AD_SELECT} WHERE a.ad_id = ANY($1)`, [adIds]);
  return r.rows.map(toAd);
}

/** A brand's ads, newest first. */
export async function brandAds(pool: Q, brandId: string): Promise<Ad[]> {
  const r = await pool.query<AdRow>(
    `${AD_SELECT} WHERE a.brand_id = $1 ORDER BY a.uploaded_at DESC, a.seq DESC LIMIT 200`,
    [brandId],
  );
  return r.rows.map(toAd);
}

/** The ads a booking runs now (its latest choice), in order. */
export async function bookingAds(pool: Q, bookingId: string): Promise<Ad[]> {
  const r = await pool.query<AdRow & { position: number }>(
    `WITH s AS (SELECT ad_ids FROM booking_ad_sets WHERE booking_id = $1
                 ORDER BY version DESC LIMIT 1)
     SELECT a.*, x.position, r.decision AS r_decision, r.reason AS r_reason,
            r.reviewed_by AS r_by, r.reviewed_at AS r_at
       FROM s, unnest(s.ad_ids) WITH ORDINALITY AS x(ad_id, position)
       JOIN ads a ON a.ad_id = x.ad_id
       LEFT JOIN ad_reviews r ON r.ad_id = x.ad_id
      ORDER BY x.position`,
    [bookingId],
  );
  return r.rows.map(toAd);
}

/** Steps where a booking's ads can still change (before it runs). Once its ads are approved, only
 * to other approved ads (the booking never steps back; nothing unreviewed can slip in). */
const CHANGEABLE = ['draft', 'awaiting-payment', 'paid', 'ads-approved'];
const AD_ID = /^AD-[0-9A-F]{10}$/;

/**
 * Chooses which of its brand's ads a booking runs: 2 to 5 (they take turns), none that failed a
 * check or was rejected, all the brand's own (once the booking's ads are approved: approved ones
 * only). Kept as the next version; nothing is replaced. A paid booking whose ads are now all
 * approved moves on to ads approved (before the deadline; after it, a reviewer decides).
 */
export async function setBookingAds(
  pool: Pool,
  bookingId: string,
  adIds: readonly string[],
  by: string,
  now: number,
): Promise<number> {
  const b = await pool.query<{ brand_id: string; first_hour_at: Date }>(
    'SELECT brand_id, first_hour_at FROM bookings WHERE booking_id = $1',
    [bookingId],
  );
  const booking = b.rows[0];
  if (!booking) throw new Refusal(`No booking ${bookingId}`);
  const ids = [...new Set(adIds)];
  const bad = ids.find((id) => !AD_ID.test(id));
  if (bad !== undefined) throw new Refusal(`${bad.slice(0, 20)} is not an ad id`);
  const { minAds, maxAds } = DEFAULT_SPOT_RULES;
  if (ids.length < minAds || ids.length > maxAds)
    throw new Refusal(`Choose ${minAds} to ${maxAds} ads (they take turns)`);
  const found = await pool.query<{
    ad_id: string;
    brand_id: string;
    outcome: CheckOutcome;
    name: string;
    decision: ReviewDecision | null;
  }>(
    `SELECT a.ad_id, a.brand_id, a.outcome, a.name, r.decision
       FROM ads a LEFT JOIN ad_reviews r USING (ad_id) WHERE a.ad_id = ANY($1)`,
    [ids],
  );
  for (const id of ids) {
    const ad = found.rows.find((x) => x.ad_id === id);
    if (!ad || ad.brand_id !== booking.brand_id)
      throw new Refusal(`${id} is not one of this brand's ads`);
    if (ad.outcome === 'fail') throw new Refusal(`${ad.name} failed the automatic checks`);
    if (ad.decision === 'rejected') throw new Refusal(`${ad.name} was rejected in review`);
  }
  const allApproved = ids.every(
    (id) => found.rows.find((x) => x.ad_id === id)?.decision === 'approved',
  );
  const version = await inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${bookingId}`]);
    // Under the booking's lock: a cancel or a step cannot slip in between the check and the write.
    const state = await bookingState(c, bookingId);
    if (!state || !CHANGEABLE.includes(state) || now >= secs(booking.first_hour_at))
      throw new Refusal('Its ads can only change before the booking runs');
    if (state === 'ads-approved' && !allApproved)
      throw new Refusal('Its ads are approved: choose only approved ads (upload and review first)');
    const v = await c.query<{ n: number }>(
      'SELECT coalesce(max(version), 0) + 1 AS n FROM booking_ad_sets WHERE booking_id = $1',
      [bookingId],
    );
    const version = v.rows[0]?.n ?? 1;
    await c.query(
      `INSERT INTO booking_ad_sets (booking_id, version, ad_ids, set_by, set_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5))`,
      [bookingId, version, ids, by, now],
    );
    return version;
  });
  if (allApproved) await advanceIfReady(pool, bookingId, { by, actor: 'admin' }, now);
  return version;
}

class NotReady extends Error {}

/**
 * Moves a paid booking to ads approved when every ad it runs (its latest choice) is approved; checked
 * again under the booking's lock, in the same transaction as the step. Before the deadline anyone
 * may trigger it (the system, after a payment); after it, only staff with a reason (short notice).
 * Returns why not, or undefined when it moved.
 */
export async function advanceIfReady(
  pool: Pool,
  bookingId: string,
  who: { readonly by: string; readonly actor: Actor; readonly reason?: string },
  now: number,
): Promise<string | undefined> {
  try {
    await moveBooking(
      pool,
      bookingId,
      'ads-approved',
      {
        ...who,
        expectFrom: 'paid',
        alsoWrite: async (c) => {
          const r = await c.query<{ chosen: number; approved: number }>(
            `WITH s AS (SELECT ad_ids FROM booking_ad_sets WHERE booking_id = $1
                         ORDER BY version DESC LIMIT 1)
             SELECT cardinality(s.ad_ids) AS chosen,
                    (SELECT count(*)::int FROM ad_reviews r
                      WHERE r.ad_id = ANY(s.ad_ids) AND r.decision = 'approved') AS approved
               FROM s`,
            [bookingId],
          );
          const x = r.rows[0];
          if (!x || x.chosen < DEFAULT_SPOT_RULES.minAds || x.approved !== x.chosen)
            throw new NotReady('not all its ads are approved yet');
        },
      },
      now,
    );
    return undefined;
  } catch (e) {
    if (e instanceof StepRace) return `the booking is ${e.now}`;
    if (e instanceof Error) return e.message;
    throw e;
  }
}
