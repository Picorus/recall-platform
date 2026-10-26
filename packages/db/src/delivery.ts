// P3.10 in the database: each booking line's delivery, for staff: plays promised and counted (from
// the screens' signed plays, by the rules it was sold on), bikes seen, the make-up and refund
// decisions made so far, and where the line stands. A booking's lines, a business day's, or the
// refunds waiting for a super admin.
import {
  lineIdOf,
  lineStartsAt,
  lineView,
  priceBookAt,
  type BookingState,
  type LineView,
  type MakeUpFacts,
  type PriceBook,
} from '@recall/domain';
import type { Pool } from 'pg';
import { priceBooks } from './bookings.js';
import { lineTotalsFor } from './plays.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

export interface DeliveryLine {
  readonly lineId: string;
  readonly bookingId: string;
  readonly brandName: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly date: string;
  readonly startHour: number;
  readonly bikes: number;
  readonly state: BookingState;
  readonly promised: number;
  /** Plays counted for the line's own hour, and different bikes that played them. */
  readonly counted: number;
  readonly bikesSeen: number;
  readonly makeUps: readonly (MakeUpFacts & { readonly makeUpId: string })[];
  readonly refund: {
    readonly refundId: string;
    readonly missing: number;
    /** What is (or would be) credited: the proposal plus any top-up added on approval. */
    readonly basePaise: number;
    readonly gstPaise: number;
    readonly decision: 'approved' | 'rejected' | null;
    readonly decidedBy: string | null;
    readonly reason: string | null;
  } | null;
  readonly view: LineView;
}

export interface DeliveryList {
  readonly lines: readonly DeliveryLine[];
  /** More lines matched than one answer carries (MAX_DELIVERY_LINES): the rest are not shown. */
  readonly truncated: boolean;
}

interface LineRow {
  booking_id: string;
  area_id: string;
  day: string;
  start_hour: number;
  bikes: number;
  plays: number;
  state: BookingState;
  brand_name: string;
  area_name: string;
  price_book_version: number;
  first_hour_at: Date;
}

/** The most lines one answer carries. */
export const MAX_DELIVERY_LINES = 300;
/** Play counts read at once (each is a few queries; the pool has a handful of connections). */
const AT_ONCE = 6;

/** The line id, as plays and make-ups store it (lineIdOf), in SQL. */
const LINE_ID = `bl.booking_id || '/' || bl.area_id || '/' || bl.day::text || '/' || bl.start_hour`;

const LINES = (where: string) => `
  SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.bikes, bl.plays,
         s.state, coalesce(bv.name, b.brand_id) AS brand_name, av.name AS area_name,
         b.price_book_version, b.first_hour_at
    FROM booking_lines bl JOIN bookings b USING (booking_id)
    JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                   ORDER BY seq DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT name FROM brand_versions v WHERE v.brand_id = b.brand_id
                        ORDER BY version DESC LIMIT 1) bv ON true
    JOIN LATERAL (SELECT name FROM area_versions a WHERE a.area_id = bl.area_id
                   ORDER BY version DESC LIMIT 1) av ON true
   WHERE ${where}
   ORDER BY bl.day, bl.start_hour, brand_name, bl.area_id, bl.booking_id
   LIMIT ${MAX_DELIVERY_LINES + 1}`;

/** Runs `f` over `xs`, a few at a time, keeping the order. */
async function inTurns<T, R>(xs: readonly T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += AT_ONCE)
    out.push(...(await Promise.all(xs.slice(i, i + AT_ONCE).map(f))));
  return out;
}

const groupBy = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

async function build(pool: Q, found: readonly LineRow[], now: number): Promise<DeliveryList> {
  const truncated = found.length > MAX_DELIVERY_LINES;
  const rows = found.slice(0, MAX_DELIVERY_LINES);
  if (rows.length === 0) return { lines: [], truncated };
  const books: readonly PriceBook[] = await priceBooks(pool);
  const ids = rows.map((r) => lineIdOf(r.booking_id, r.area_id, r.day, r.start_hour));
  const [decided, makeUps, refunds] = await Promise.all([
    pool.query<{ line_id: string; step: 'first' | 'second' | 'refund'; outcome: string }>(
      'SELECT line_id, step, outcome FROM line_settlements WHERE line_id = ANY($1)',
      [ids],
    ),
    pool.query<{
      make_up_id: string;
      line_id: string;
      stage: 1 | 2;
      window_from: Date;
      window_until: Date;
      plays: number;
    }>(
      `SELECT make_up_id, line_id, stage, window_from, window_until, plays FROM make_ups
        WHERE line_id = ANY($1) ORDER BY stage`,
      [ids],
    ),
    pool.query<{
      refund_id: string;
      line_id: string;
      missing_plays: number;
      base_paise: string;
      gst_paise: string;
      decision: 'approved' | 'rejected' | null;
      decided_by: string | null;
      reason: string | null;
    }>(
      `SELECT r.refund_id, r.line_id, r.missing_plays + coalesce(t.missing_plays, 0) AS missing_plays,
              r.base_paise + coalesce(t.base_paise, 0) AS base_paise,
              r.gst_paise + coalesce(t.gst_paise, 0) AS gst_paise,
              d.decision, d.decided_by, d.reason
         FROM refunds r LEFT JOIN refund_decisions d USING (refund_id)
         LEFT JOIN refund_topups t USING (refund_id)
        WHERE r.line_id = ANY($1)`,
      [ids],
    ),
  ]);
  const decidedBy = groupBy(decided.rows, (d) => d.line_id);
  const makeUpsBy = groupBy(makeUps.rows, (m) => m.line_id);
  const refundBy = new Map(refunds.rows.map((r) => [r.line_id, r]));
  // Counted the same way as the money is (play-counting rules of the price book it was sold on).
  const totals = await inTurns(ids, (id) => lineTotalsFor(pool, id, books));
  const madeUp = new Map(
    (
      await inTurns(makeUps.rows, async (m) => [
        m.make_up_id,
        (await lineTotalsFor(pool, m.make_up_id, books)).plays,
      ])
    ).map(([k, v]) => [k as string, v as number]),
  );
  const lines = rows.map((r, i): DeliveryLine => {
    const lineId = ids[i] ?? '';
    const t = totals[i];
    const ups = (makeUpsBy.get(lineId) ?? []).map((m) => ({
      makeUpId: m.make_up_id,
      stage: m.stage,
      from: secs(m.window_from),
      until: secs(m.window_until),
      owed: m.plays,
      counted: madeUp.get(m.make_up_id) ?? 0,
    }));
    const rf = refundBy.get(lineId);
    const refund = rf
      ? {
          refundId: rf.refund_id,
          missing: rf.missing_plays,
          basePaise: Number(rf.base_paise),
          gstPaise: Number(rf.gst_paise),
          decision: rf.decision,
          decidedBy: rf.decided_by,
          reason: rf.reason,
        }
      : null;
    const book = books.find((b) => b.version === r.price_book_version);
    return {
      lineId,
      bookingId: r.booking_id,
      brandName: r.brand_name,
      areaId: r.area_id,
      areaName: r.area_name,
      date: r.day,
      startHour: r.start_hour,
      bikes: r.bikes,
      state: r.state,
      promised: r.plays,
      counted: t?.plays ?? 0,
      bikesSeen: t?.bikes ?? 0,
      makeUps: ups,
      refund,
      view: lineView(
        {
          state: r.state,
          startsAt: lineStartsAt({ date: r.day, startHour: r.start_hour }),
          bookingStartsAt: secs(r.first_hour_at),
          promised: r.plays,
          counted: t?.plays ?? 0,
          decided: decidedBy.get(lineId) ?? [],
          makeUps: ups,
          refund,
        },
        now,
        // The make-up rules of the price book it was sold on (settings, versioned).
        (book ?? priceBookAt(books, new Date(now * 1000).toISOString()))?.makeUps,
      ),
    };
  });
  return { lines, truncated };
}

/** Every line of one booking, in time order. */
export async function bookingDelivery(
  pool: Q,
  bookingId: string,
  now: number,
): Promise<DeliveryList> {
  const r = await pool.query<LineRow>(LINES('bl.booking_id = $1'), [bookingId]);
  return build(pool, r.rows, now);
}

/**
 * One business day (its date: 08:00 to 02:00 India time): the lines sold for it (paid or further on;
 * drafts and unpaid ones left out, cancelled ones only with a refund), and earlier lines whose
 * make-up runs that day. In time order.
 */
export async function dayDelivery(pool: Q, date: string, now: number): Promise<DeliveryList> {
  const r = await pool.query<LineRow>(
    LINES(`(bl.day = $1::date
             AND (s.state NOT IN ('draft', 'awaiting-payment', 'cancelled')
                  OR EXISTS (SELECT 1 FROM refunds f WHERE f.line_id = ${LINE_ID})))
            OR EXISTS (SELECT 1 FROM make_ups m WHERE m.line_id = ${LINE_ID} AND m.day = $1::date)`),
    [date],
  );
  return build(pool, r.rows, now);
}

/** Every proposed refund still waiting for a super admin, oldest line first (any day, any step). */
export async function refundsWaiting(pool: Q, now: number): Promise<DeliveryList> {
  const r = await pool.query<LineRow>(
    LINES(`EXISTS (SELECT 1 FROM refunds f WHERE f.line_id = ${LINE_ID}
                     AND NOT EXISTS (SELECT 1 FROM refund_decisions d
                                      WHERE d.refund_id = f.refund_id))`),
  );
  return build(pool, r.rows, now);
}
