// P3.10 in the database: each booking line's delivery, for staff: plays promised and counted (from
// the screens' signed plays, by the rules it was sold on), bikes seen, the make-up and refund
// decisions made so far, and where the line stands. A booking's lines, or a business day's.
import {
  lineIdOf,
  lineStartsAt,
  lineView,
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
  /** Plays counted for the line itself, and different bikes that played them. */
  readonly counted: number;
  readonly bikesSeen: number;
  readonly makeUps: readonly (MakeUpFacts & { readonly makeUpId: string })[];
  readonly refund: {
    readonly refundId: string;
    readonly missing: number;
    readonly basePaise: number;
    readonly gstPaise: number;
    readonly decision: 'approved' | 'rejected' | null;
    readonly decidedBy: string | null;
    readonly reason: string | null;
  } | null;
  readonly view: LineView;
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
}

/** The most lines one answer carries. */
export const MAX_DELIVERY_LINES = 300;

const LINES = (where: string) => `
  SELECT bl.booking_id, bl.area_id, bl.day::text AS day, bl.start_hour, bl.bikes, bl.plays,
         s.state, coalesce(bv.name, b.brand_id) AS brand_name, av.name AS area_name
    FROM booking_lines bl JOIN bookings b USING (booking_id)
    JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                   ORDER BY seq DESC LIMIT 1) s ON true
    LEFT JOIN LATERAL (SELECT name FROM brand_versions v WHERE v.brand_id = b.brand_id
                        ORDER BY version DESC LIMIT 1) bv ON true
    JOIN LATERAL (SELECT name FROM area_versions a WHERE a.area_id = bl.area_id
                   ORDER BY version DESC LIMIT 1) av ON true
   WHERE ${where}
   ORDER BY bl.day, bl.start_hour, bv.name, bl.area_id, bl.booking_id
   LIMIT ${MAX_DELIVERY_LINES}`;

async function build(pool: Q, rows: readonly LineRow[], now: number): Promise<DeliveryLine[]> {
  if (rows.length === 0) return [];
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
      `SELECT r.refund_id, r.line_id, r.missing_plays, r.base_paise, r.gst_paise, d.decision,
              d.decided_by, d.reason
         FROM refunds r LEFT JOIN refund_decisions d USING (refund_id) WHERE r.line_id = ANY($1)`,
      [ids],
    ),
  ]);
  const out: DeliveryLine[] = [];
  for (const [i, r] of rows.entries()) {
    const lineId = ids[i] ?? '';
    // Counted the same way as the money is (play-counting rules of the price book it was sold on).
    const totals = await lineTotalsFor(pool, lineId, books);
    const mine = makeUps.rows.filter((m) => m.line_id === lineId);
    const ups = [];
    for (const m of mine)
      ups.push({
        makeUpId: m.make_up_id,
        stage: m.stage,
        from: secs(m.window_from),
        until: secs(m.window_until),
        owed: m.plays,
        counted: (await lineTotalsFor(pool, m.make_up_id, books)).plays,
      });
    const rf = refunds.rows.find((x) => x.line_id === lineId);
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
    out.push({
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
      counted: totals.plays,
      bikesSeen: totals.bikes,
      makeUps: ups,
      refund,
      view: lineView(
        {
          state: r.state,
          startsAt: lineStartsAt({ date: r.day, startHour: r.start_hour }),
          promised: r.plays,
          counted: totals.plays,
          decided: decided.rows.filter((d) => d.line_id === lineId),
          makeUps: ups,
          refund,
        },
        now,
      ),
    });
  }
  return out;
}

/** Every line of one booking, in time order. */
export async function bookingDelivery(
  pool: Q,
  bookingId: string,
  now: number,
): Promise<DeliveryLine[]> {
  const r = await pool.query<LineRow>(LINES('bl.booking_id = $1'), [bookingId]);
  return build(pool, r.rows, now);
}

/**
 * The lines of one business day (its date: 08:00 to 02:00 India time) for bookings that were sold
 * (paid or further on; cancelled ones and drafts left out), in time order.
 */
export async function dayDelivery(pool: Q, date: string, now: number): Promise<DeliveryLine[]> {
  const r = await pool.query<LineRow>(
    LINES(`bl.day = $1::date AND s.state NOT IN ('draft', 'awaiting-payment', 'cancelled')`),
    [date],
  );
  return build(pool, r.rows, now);
}
