// P1.9.1: building each booking's final report once its last make-up has had time to play, and
// keeping it exactly as built. Read-only on money: refunds are shown as they stand, never decided.
import type { MapsAdapter } from '@recall/adapters';
import {
  campaignReport,
  DEFAULT_MAKE_UP_RULES,
  DEFAULT_REPORT_RULES,
  heatMap,
  lineIdOf,
  makeUpWindows,
  refundPaise,
  type CampaignReport,
  type LineForReport,
  type PriceBook,
  type RefundStatus,
} from '@recall/domain';
import type { Pool } from 'pg';
import { moveBooking, priceBooks } from './bookings.js';
import { inTransaction, paidForLine, type OpenLine } from './makeups.js';
import { bookingPeople } from './people.js';
import { countedPlaysFor } from './plays.js';

/** Bookings whose report may be built: they ran (or were set to run) and are not cancelled. */
const REPORTABLE = ['ads-approved', 'running', 'done'];

interface Candidate extends Omit<OpenLine, 'area_id' | 'day' | 'start_hour' | 'plays' | 'paise'> {
  readonly brand_id: string;
  readonly state: string;
  readonly first: string;
  readonly last: string;
}

/**
 * When a booking's report is due: `afterHours` after its last hour, and never before every line's
 * last make-up window (the same hour the next day) has ended and its late uploads have come in.
 */
export function reportDueAt(
  lines: readonly { readonly areaId: string; readonly date: string; readonly startHour: number }[],
  lastHourEndsAt: number,
  book: PriceBook | undefined,
): number {
  const rules = book?.makeUps ?? DEFAULT_MAKE_UP_RULES;
  const after = (book?.report ?? DEFAULT_REPORT_RULES).afterHours * 3600;
  let due = lastHourEndsAt + after;
  for (const l of lines) {
    const w = makeUpWindows({ lineId: '', ...l }, rules);
    due = Math.max(due, w.second.until + rules.closeAfterSeconds);
  }
  return due;
}

/** Builds one booking's report from what is stored now (does not save it). */
async function build(
  pool: Pool,
  maps: MapsAdapter,
  b: Candidate,
  books: readonly PriceBook[],
  now: number,
): Promise<CampaignReport> {
  const book = books.find((x) => x.version === b.price_book_version);
  const rules = book?.report ?? DEFAULT_REPORT_RULES;
  const lines = await pool.query<OpenLine & { bikes: number }>(
    `SELECT booking_id, area_id, day::text AS day, start_hour, plays, paise, bikes
       FROM booking_lines WHERE booking_id = $1 ORDER BY day, start_hour, area_id`,
    [b.booking_id],
  );
  const makeUps = await pool.query<{ make_up_id: string; line_id: string }>(
    'SELECT make_up_id, line_id FROM make_ups WHERE booking_id = $1',
    [b.booking_id],
  );
  const refunds = await pool.query<{
    line_id: string;
    base_paise: string;
    decision: string | null;
  }>(
    `SELECT r.line_id, r.base_paise, d.decision FROM refunds r
       LEFT JOIN refund_decisions d USING (refund_id) WHERE r.booking_id = $1`,
    [b.booking_id],
  );
  const c = await pool.connect();
  const out: LineForReport[] = [];
  let estimated = 0;
  try {
    for (const l of lines.rows) {
      const lineId = lineIdOf(b.booking_id, l.area_id, l.day, l.start_hour);
      const hourPlays = await countedPlaysFor(pool, lineId, books);
      const makeUpPlays = (
        await Promise.all(
          makeUps.rows
            .filter((m) => m.line_id === lineId)
            .map((m) => countedPlaysFor(pool, m.make_up_id, books)),
        )
      ).flat();
      const missing = Math.max(0, l.plays - hourPlays.length - makeUpPlays.length);
      const r = refunds.rows.find((x) => x.line_id === lineId);
      let refund: { paise: number; status: RefundStatus } | undefined;
      if (r) {
        refund = {
          paise: Number(r.base_paise),
          status:
            r.decision === 'approved' || r.decision === 'rejected' ? r.decision : 'under review',
        };
      } else if (missing > 0 && book && !b.trial) {
        // Not proposed yet (that happens when the day closes): the same sum the proposal will use,
        // never more than the bill.
        const paid = await paidForLine(c, { ...b, ...l }, book);
        const paise = Math.min(
          refundPaise(missing, l.plays, paid),
          Number(b.subtotal_paise) - estimated,
        );
        estimated += paise;
        if (paise > 0) refund = { paise, status: 'under review' };
      }
      out.push({
        lineId,
        areaId: l.area_id,
        date: l.day,
        startHour: l.start_hour,
        bikes: l.bikes,
        promised: l.plays,
        hourPlays,
        makeUpPlays,
        ...(refund ? { refund } : {}),
      });
    }
  } finally {
    c.release();
  }
  // Street names for the busiest hexagons only (each is a maps call).
  const cells = heatMap(
    out.flatMap((l) => [...l.hourPlays, ...l.makeUpPlays]),
    rules.h3Resolution,
  ).slice(0, rules.streetCells);
  const streetOf = new Map<string, string>();
  for (const cell of cells) {
    const name = await maps.streetAt(cell.lat, cell.lng);
    if (name !== undefined) streetOf.set(cell.cell, name);
  }
  const people = await bookingPeople(pool, b.booking_id);
  if (!people) throw new Error(`No booking ${b.booking_id}`);
  return campaignReport({
    bookingId: b.booking_id,
    brandId: b.brand_id,
    from: Number(b.first),
    until: Number(b.last),
    builtAt: now,
    lines: out,
    makeUpsOpened: makeUps.rows.length,
    streetOf,
    people: people.estimate,
    rules,
  });
}

export interface ReportsBuilt {
  readonly built: readonly string[];
  /** Bookings whose report could not be built this time (each on its own), with why. */
  readonly failed: readonly { readonly bookingId: string; readonly error: string }[];
}

/**
 * Builds every report that is due at `now` (P1.9.1), moving each booking on to done first (the
 * clock moves it: running once its first hour started, done once its last hour ended). Safe to run
 * as often as wanted: each report is built once and kept as built.
 */
export async function buildDueReports(
  pool: Pool,
  maps: MapsAdapter,
  now: number,
): Promise<ReportsBuilt> {
  const books = await priceBooks(pool);
  const due = await pool.query<Candidate>(
    `SELECT b.booking_id, b.brand_id, b.trial, b.discount_paise, b.subtotal_paise, b.gst_paise,
            b.price_book_version, s.state,
            extract(epoch FROM b.first_hour_at)::bigint AS first,
            extract(epoch FROM b.last_hour_ends_at)::bigint AS last
       FROM bookings b
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                      ORDER BY seq DESC LIMIT 1) s ON true
      WHERE s.state = ANY($1) AND b.last_hour_ends_at <= to_timestamp($2)
        AND NOT EXISTS (SELECT 1 FROM campaign_reports r WHERE r.booking_id = b.booking_id)
      ORDER BY b.last_hour_ends_at, b.booking_id`,
    [REPORTABLE, now],
  );
  const built: string[] = [];
  const failed: { bookingId: string; error: string }[] = [];
  for (const b of due.rows) {
    try {
      const lines = await pool.query<{ area_id: string; day: string; start_hour: number }>(
        'SELECT area_id, day::text AS day, start_hour FROM booking_lines WHERE booking_id = $1',
        [b.booking_id],
      );
      const dueAt = reportDueAt(
        lines.rows.map((l) => ({ areaId: l.area_id, date: l.day, startHour: l.start_hour })),
        Number(b.last),
        books.find((x) => x.version === b.price_book_version),
      );
      if (now < dueAt) continue;
      const who = { by: 'system', actor: 'system' } as const;
      if (b.state === 'ads-approved') await moveBooking(pool, b.booking_id, 'running', who, now);
      if (b.state !== 'done') await moveBooking(pool, b.booking_id, 'done', who, now);
      const report = await build(pool, maps, b, books, now);
      const saved = await inTransaction(pool, async (c) => {
        const r = await c.query(
          `INSERT INTO campaign_reports (booking_id, built_at, report)
           VALUES ($1, to_timestamp($2), $3) ON CONFLICT DO NOTHING`,
          [b.booking_id, now, JSON.stringify(report)],
        );
        return r.rowCount === 1;
      });
      if (saved) built.push(b.booking_id);
    } catch (e) {
      failed.push({ bookingId: b.booking_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { built, failed };
}

/** A booking's final report, as it was built, or undefined when it has none yet. */
export async function campaignReportFor(
  pool: Pick<Pool, 'query'>,
  bookingId: string,
): Promise<CampaignReport | undefined> {
  const r = await pool.query<{ report: CampaignReport }>(
    'SELECT report FROM campaign_reports WHERE booking_id = $1',
    [bookingId],
  );
  return r.rows[0]?.report;
}
