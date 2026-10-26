// P3.9.2 in the database: an Ad review admin's decision on each ad (final, never edited), the
// booking steps it unlocks, and the queue of what waits for a person.
import {
  REVIEW_CHECKLIST,
  reasonProblem,
  reviewProblem,
  staffIdOf,
  type ReviewDecision,
} from '@recall/domain';
import type { Pool } from 'pg';
import { adById, adsByIds, advanceIfReady, type Ad } from './ads.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

/** Bookings still to run (first hour after $1), with their latest choice of ads and step now. */
const LATEST = `
  latest AS (
    SELECT b.booking_id, b.ads_due_at, b.first_hour_at, b.brand_id, l.ad_ids, s.state
      FROM bookings b
      JOIN LATERAL (SELECT ad_ids FROM booking_ad_sets a WHERE a.booking_id = b.booking_id
                     ORDER BY version DESC LIMIT 1) l ON true
      JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                     ORDER BY seq DESC LIMIT 1) s ON true
     WHERE b.first_hour_at > to_timestamp($1))`;
/** Every ad in the booking's latest choice is approved. */
const ALL_APPROVED = `NOT EXISTS (SELECT 1 FROM unnest(l.ad_ids) x(ad_id)
                     WHERE NOT EXISTS (SELECT 1 FROM ad_reviews v
                                        WHERE v.ad_id = x.ad_id AND v.decision = 'approved'))`;
/** A brand's name now. */
const BRAND_NAME = (brandId: string) =>
  `JOIN LATERAL (SELECT name FROM brand_versions bv WHERE bv.brand_id = ${brandId}
                  ORDER BY version DESC LIMIT 1) v ON true`;

export interface ReviewOutcome {
  /** Bookings this decision moved to ads approved. */
  readonly approvedBookings: readonly string[];
  /** Paid bookings whose ads are now all approved but could not move (short notice), and why. */
  readonly waiting: readonly { bookingId: string; problem: string }[];
}

/**
 * Records a reviewer's decision on an ad: approved (every rule on the checklist ticked; never an ad
 * that failed the automatic checks) or rejected (with why). One decision per ad, never by the person
 * who uploaded it (a super admin may: in the POC one person may do both). An approval moves on every
 * paid booking whose ads are now all approved, before its deadline; a booking past its deadline
 * waits for its own short-notice approval (each with its own reason, never this ad's).
 */
export async function reviewAd(
  pool: Pool,
  r: {
    readonly adId: string;
    readonly decision: ReviewDecision;
    readonly reason: string | null;
    readonly checklist: Readonly<Record<string, boolean>>;
    /** "Name (staff id)". */
    readonly by: string;
    readonly superAdmin: boolean;
  },
  now: number,
): Promise<ReviewOutcome> {
  const ad = await adById(pool, r.adId);
  if (!ad) throw new Refusal(`No ad ${r.adId}`);
  if (ad.review)
    throw new Refusal(`${ad.name} was already ${ad.review.decision} by ${ad.review.by}`);
  const mine = staffIdOf(r.by);
  if (!r.superAdmin && mine !== null && mine === staffIdOf(ad.uploadedBy))
    throw new Refusal('You uploaded this ad: someone else reviews it');
  const reason = r.decision === 'rejected' ? r.reason?.trim() || null : null;
  const problem = reviewProblem({ ...r, reason, outcome: ad.outcome });
  if (problem) throw new Refusal(problem);
  // Only the checklist's own rules are kept, as ticked or not.
  const checklist = Object.fromEntries(
    REVIEW_CHECKLIST.map((c) => [c.key, r.checklist[c.key] === true]),
  );
  const saved = await pool.query(
    `INSERT INTO ad_reviews (ad_id, decision, reason, checklist, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6)) ON CONFLICT (ad_id) DO NOTHING`,
    [r.adId, r.decision, reason, JSON.stringify(checklist), r.by, now],
  );
  if (!saved.rowCount) throw new Refusal(`${ad.name} was already decided`);
  if (r.decision !== 'approved') return { approvedBookings: [], waiting: [] };
  const using = await pool.query<{ booking_id: string }>(
    `WITH ${LATEST}
     SELECT l.booking_id FROM latest l
      WHERE $2 = ANY(l.ad_ids) AND l.state = 'paid' AND ${ALL_APPROVED}
      ORDER BY l.booking_id`,
    [now, r.adId],
  );
  const approvedBookings: string[] = [];
  const waiting: { bookingId: string; problem: string }[] = [];
  for (const b of using.rows) {
    const why = await advanceIfReady(pool, b.booking_id, { by: r.by, actor: 'admin' }, now);
    if (why) waiting.push({ bookingId: b.booking_id, problem: why });
    else approvedBookings.push(b.booking_id);
  }
  return { approvedBookings, waiting };
}

/** A paid booking whose ads are all approved, past its deadline: a reviewer approves it on short
 * notice, with why (logged on the booking's step). */
export async function approveOnShortNotice(
  pool: Pool,
  bookingId: string,
  by: string,
  reason: string,
  now: number,
): Promise<void> {
  const bad = reasonProblem(reason);
  if (bad) throw new Refusal(bad);
  const why = await advanceIfReady(
    pool,
    bookingId,
    { by, actor: 'admin', reason: reason.trim() },
    now,
  );
  if (why) throw new Refusal(`Cannot approve ${bookingId}: ${why}`);
}

export interface QueueAd extends Ad {
  readonly brandName: string;
  /** The earliest deadline among the live bookings that chose it (UTC seconds), or null. */
  readonly neededBy: number | null;
  readonly bookings: readonly string[];
}

export interface ReviewQueue {
  /** Ads waiting for a decision (not those that failed the automatic checks: they cannot run):
   * those bookings need soonest first, then the oldest uploads. */
  readonly waiting: readonly QueueAd[];
  /** Paid bookings still to run whose ads are all approved, past their deadline: each waits for a
   * reviewer's short-notice approval. */
  readonly shortNotice: readonly {
    bookingId: string;
    brandName: string;
    adsDueAt: number;
    firstHourAt: number;
  }[];
  /** The latest decisions. */
  readonly recent: readonly (Ad & { brandName: string })[];
}

interface QueueRow {
  ad_id: string;
  brand_name: string;
  needed_by: Date | null;
  bookings: string[] | null;
}

export async function reviewQueue(pool: Q, now: number): Promise<ReviewQueue> {
  const w = await pool.query<QueueRow>(
    `WITH ${LATEST},
     wanted AS (
       SELECT x.ad_id, min(l.ads_due_at) AS needed_by,
              array_agg(l.booking_id ORDER BY l.booking_id) AS bookings
         FROM latest l CROSS JOIN LATERAL unnest(l.ad_ids) x(ad_id)
        WHERE l.state IN ('draft', 'awaiting-payment', 'paid')
        GROUP BY x.ad_id)
     SELECT a.ad_id, v.name AS brand_name, wd.needed_by, wd.bookings
       FROM ads a ${BRAND_NAME('a.brand_id')}
       LEFT JOIN wanted wd USING (ad_id)
      WHERE NOT EXISTS (SELECT 1 FROM ad_reviews r WHERE r.ad_id = a.ad_id)
        AND a.outcome <> 'fail'
      ORDER BY wd.needed_by ASC NULLS LAST, a.uploaded_at, a.seq
      LIMIT 200`,
    [now],
  );
  const found = new Map(
    (
      await adsByIds(
        pool,
        w.rows.map((x) => x.ad_id),
      )
    ).map((a) => [a.adId, a]),
  );
  const waiting: QueueAd[] = w.rows.flatMap((x) => {
    const ad = found.get(x.ad_id);
    return ad
      ? [
          {
            ...ad,
            brandName: x.brand_name,
            neededBy: x.needed_by ? secs(x.needed_by) : null,
            bookings: x.bookings ?? [],
          },
        ]
      : [];
  });
  const s = await pool.query<{
    booking_id: string;
    brand_name: string;
    ads_due_at: Date;
    first_hour_at: Date;
  }>(
    `WITH ${LATEST}
     SELECT l.booking_id, v.name AS brand_name, l.ads_due_at, l.first_hour_at
       FROM latest l ${BRAND_NAME('l.brand_id')}
      WHERE l.state = 'paid' AND l.ads_due_at <= to_timestamp($1) AND ${ALL_APPROVED}
      ORDER BY l.first_hour_at
      LIMIT 100`,
    [now],
  );
  const r = await pool.query<{ ad_id: string; brand_name: string }>(
    `SELECT r.ad_id, v.name AS brand_name FROM ad_reviews r JOIN ads a USING (ad_id)
       ${BRAND_NAME('a.brand_id')}
      ORDER BY r.reviewed_at DESC, r.ad_id LIMIT 30`,
  );
  const decided = new Map(
    (
      await adsByIds(
        pool,
        r.rows.map((x) => x.ad_id),
      )
    ).map((a) => [a.adId, a]),
  );
  const recent = r.rows.flatMap((x) => {
    const ad = decided.get(x.ad_id);
    return ad ? [{ ...ad, brandName: x.brand_name }] : [];
  });
  return {
    waiting,
    shortNotice: s.rows.map((x) => ({
      bookingId: x.booking_id,
      brandName: x.brand_name,
      adsDueAt: secs(x.ads_due_at),
      firstHourAt: secs(x.first_hour_at),
    })),
    recent,
  };
}
