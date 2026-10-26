// P3.9.1 in the database: ads uploaded for a brand (checked automatically, stored by fingerprint)
// and which of them each booking runs.
import type { FileStore } from '@recall/adapters';
import {
  adFacts,
  checkAd,
  DEFAULT_SPOT_RULES,
  isoAt,
  priceBookAt,
  worst,
  type AdCheck,
  type AdKind,
  type CheckOutcome,
} from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { bookingState, priceBooks } from './bookings.js';
import { findAccount } from './brands.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
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
}
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
  const name = a.name.trim();
  if (name.length < 1 || name.length > 80)
    throw new Refusal('Give the ad a name (1 to 80 characters)');
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  if (!book) throw new Refusal('No price book in force');
  const facts = adFacts(a.data);
  const checks = checkAd(facts, book.ads);
  if (facts.kind === null) throw new Refusal('Not a picture (PNG, JPEG, WebP) or an MP4 video');
  const stored = await store.put(a.data, CONTENT_TYPE[facts.kind]);
  const adId = `AD-${randomBytes(5).toString('hex').toUpperCase()}`;
  const r = await inTransaction(pool, (c) =>
    c.query<AdRow>(
      `INSERT INTO ads (ad_id, brand_id, name, file_key, bytes, kind, width, height, duration_ms,
                        codec, checks, outcome, uploaded_by, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14))
       RETURNING *`,
      [
        adId,
        a.brandId,
        name,
        stored.key,
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
    ),
  );
  const row = r.rows[0];
  if (!row) throw new Error('ad not saved');
  return toAd(row);
}

export async function adById(pool: Q, adId: string): Promise<Ad | undefined> {
  const r = await pool.query<AdRow>('SELECT * FROM ads WHERE ad_id = $1', [adId]);
  return r.rows[0] ? toAd(r.rows[0]) : undefined;
}

/** A brand's ads, newest first. */
export async function brandAds(pool: Q, brandId: string): Promise<Ad[]> {
  const r = await pool.query<AdRow>(
    'SELECT * FROM ads WHERE brand_id = $1 ORDER BY uploaded_at DESC, ad_id LIMIT 200',
    [brandId],
  );
  return r.rows.map(toAd);
}

/** The ads a booking runs now (its latest choice), in order. */
export async function bookingAds(pool: Q, bookingId: string): Promise<Ad[]> {
  const r = await pool.query<AdRow & { position: number }>(
    `WITH s AS (SELECT ad_ids FROM booking_ad_sets WHERE booking_id = $1
                 ORDER BY version DESC LIMIT 1)
     SELECT a.*, x.position FROM s, unnest(s.ad_ids) WITH ORDINALITY AS x(ad_id, position)
       JOIN ads a ON a.ad_id = x.ad_id
      ORDER BY x.position`,
    [bookingId],
  );
  return r.rows.map(toAd);
}

/** Steps where a booking's ads can still change (before it runs). */
const CHANGEABLE = ['draft', 'awaiting-payment', 'paid', 'ads-approved'];

/**
 * Chooses which of its brand's ads a booking runs: 2 to 5 (they take turns), none that failed a
 * check, all the brand's own. Kept as the next version; nothing is replaced.
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
  const state = await bookingState(pool, bookingId);
  if (!state || !CHANGEABLE.includes(state) || now >= secs(booking.first_hour_at))
    throw new Refusal('Its ads can only change before the booking runs');
  const ids = [...new Set(adIds)];
  const { minAds, maxAds } = DEFAULT_SPOT_RULES;
  if (ids.length < minAds || ids.length > maxAds)
    throw new Refusal(`Choose ${minAds} to ${maxAds} ads (they take turns)`);
  const found = await pool.query<{
    ad_id: string;
    brand_id: string;
    outcome: CheckOutcome;
    name: string;
  }>('SELECT ad_id, brand_id, outcome, name FROM ads WHERE ad_id = ANY($1)', [ids]);
  for (const id of ids) {
    const ad = found.rows.find((x) => x.ad_id === id);
    if (!ad || ad.brand_id !== booking.brand_id)
      throw new Refusal(`${id} is not one of this brand's ads`);
    if (ad.outcome === 'fail') throw new Refusal(`${ad.name} failed the automatic checks`);
  }
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${bookingId}`]);
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
}
