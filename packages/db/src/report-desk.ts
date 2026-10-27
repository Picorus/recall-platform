// P3.14.1: final campaign reports in admin. Every booking whose campaign has ended, with where its
// report stands (waiting for its last checks, built and being sent, sent, no contact, could not be
// delivered), and a staff re-send on WhatsApp or email to the brand's contact now (its own message,
// recorded with who asked). Reports are never changed: they stay exactly as built.
import type { MessagesAdapter } from '@recall/adapters';
import type { CampaignReport } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { sendReportMessage, type Channel, type ReportRender } from './report-sends.js';

type Q = Pick<PoolClient, 'query'>;

export type ReportStage = 'checking' | 'sending' | 'sent' | 'no contact' | 'undelivered';

export interface ReportRow {
  readonly bookingId: string;
  readonly brandId: string;
  readonly brandName: string;
  readonly from: number;
  readonly until: number;
  readonly stage: ReportStage;
  readonly builtAt: number | null;
  /** From the report, once built. */
  readonly promised: number | null;
  readonly delivered: number | null;
  readonly deliveredBp: number | null;
  /** Each channel's last try (or none). */
  readonly sends: Readonly<
    Partial<Record<Channel, { status: 'sent' | 'failed'; to: string; at: number; tries: number }>>
  >;
}

const secs = (d: Date) => Math.floor(d.getTime() / 1000);
/** A staff re-send on a channel is refused this soon after the last try (a double press). */
const RESEND_GAP_S = 120;

/**
 * Campaigns that have ended (newest first, at most 200) and where each report stands. "Undelivered"
 * means every channel failed for good: staff fix the contact (Brands) or re-send.
 */
export async function reportList(c: Q, now: number): Promise<ReportRow[]> {
  const r = await c.query<{
    booking_id: string;
    brand_id: string;
    brand_name: string;
    first: Date;
    last: Date;
    state: string;
    built_at: Date | null;
    report: CampaignReport | null;
    has_contact: boolean;
  }>(
    `SELECT b.booking_id, b.brand_id,
            coalesce((SELECT v.name FROM brand_versions v WHERE v.brand_id = b.brand_id
                       ORDER BY v.version DESC LIMIT 1), b.brand_id) AS brand_name,
            b.first_hour_at AS first, b.last_hour_ends_at AS last, s.state,
            r.built_at, r.report,
            EXISTS (SELECT 1 FROM brand_contacts k WHERE k.brand_id = b.brand_id) AS has_contact
       FROM bookings b
       JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                      ORDER BY seq DESC LIMIT 1) s ON true
       LEFT JOIN campaign_reports r USING (booking_id)
      WHERE b.last_hour_ends_at <= to_timestamp($1)
        AND s.state IN ('ads-approved', 'running', 'done', 'report-sent')
      ORDER BY b.last_hour_ends_at DESC, b.booking_id LIMIT 200`,
    [now],
  );
  const ids = r.rows.map((x) => x.booking_id);
  const sends = ids.length
    ? await c.query<{
        booking_id: string;
        channel: Channel;
        status: 'sent' | 'failed';
        sent_to: string;
        at: Date;
        retryable: boolean;
        n: string;
      }>(
        `SELECT DISTINCT ON (booking_id, channel) booking_id, channel, status, sent_to, at,
                retryable, count(*) OVER (PARTITION BY booking_id, channel) AS n
           FROM report_sends WHERE booking_id = ANY($1)
          ORDER BY booking_id, channel, try DESC`,
        [ids],
      )
    : { rows: [] };
  return r.rows.map((x) => {
    const mine = sends.rows.filter((s) => s.booking_id === x.booking_id);
    const byChannel: Partial<
      Record<Channel, { status: 'sent' | 'failed'; to: string; at: number; tries: number }>
    > = {};
    for (const s of mine)
      byChannel[s.channel] = {
        status: s.status,
        to: s.sent_to,
        at: secs(s.at),
        tries: Number(s.n),
      };
    const anySent = mine.some((s) => s.status === 'sent');
    const stage: ReportStage =
      x.state === 'report-sent' || anySent
        ? 'sent'
        : !x.report
          ? 'checking'
          : !x.has_contact
            ? 'no contact'
            : mine.length > 0 && mine.every((s) => s.status === 'failed' && !s.retryable)
              ? 'undelivered'
              : 'sending';
    return {
      bookingId: x.booking_id,
      brandId: x.brand_id,
      brandName: x.brand_name,
      from: secs(x.first),
      until: secs(x.last),
      stage,
      builtAt: x.built_at ? secs(x.built_at) : null,
      promised: x.report?.promised ?? null,
      delivered: x.report?.delivered ?? null,
      deliveredBp: x.report?.deliveredBp ?? null,
      sends: byChannel,
    };
  });
}

/**
 * Sends a built report again to the brand's contact now, on one channel, asked by staff (a brand
 * lost it, or a new address was added). Its own message (never the first one replayed), recorded
 * with who asked. Not while the automatic sender is running, nor twice within two minutes.
 */
export async function resendReport(
  pool: Pool,
  messages: MessagesAdapter,
  render: ReportRender,
  bookingId: string,
  channel: Channel,
  by: { readonly id: string; readonly name: string },
  now: number,
): Promise<'sent' | 'failed'> {
  const lock = await pool.connect();
  let broken: Error | undefined;
  try {
    const got = await lock.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('report-sends')) AS ok",
    );
    if (!got.rows[0]?.ok) throw new Refusal('Reports are being sent just now: try again');
    try {
      const r = await pool.query<{ brand_id: string; report: CampaignReport }>(
        `SELECT b.brand_id, r.report FROM campaign_reports r JOIN bookings b USING (booking_id)
          WHERE r.booking_id = $1`,
        [bookingId],
      );
      const row = r.rows[0];
      if (!row) throw new Refusal(`No report for ${bookingId} yet`);
      const contact = await pool.query<{ phone: string | null; email: string | null }>(
        `SELECT phone, email FROM brand_contacts WHERE brand_id = $1
          ORDER BY set_at DESC LIMIT 1`,
        [row.brand_id],
      );
      const to = channel === 'whatsapp' ? contact.rows[0]?.phone : contact.rows[0]?.email;
      if (!to)
        throw new Refusal(
          `The brand has no ${channel === 'whatsapp' ? 'WhatsApp number' : 'email'}: add it on its page (Brands)`,
        );
      const tries = await pool.query<{ n: number; last: Date | null }>(
        `SELECT count(*)::int AS n, max(at) AS last FROM report_sends
          WHERE booking_id = $1 AND channel = $2`,
        [bookingId, channel],
      );
      const n = tries.rows[0]?.n ?? 0;
      const last = tries.rows[0]?.last;
      if (last && now - secs(last) < RESEND_GAP_S)
        throw new Refusal('It was just sent on this channel: wait two minutes');
      const result = await sendReportMessage(
        messages,
        channel,
        to,
        row.report,
        render,
        `report-resend:${bookingId}:${channel}:${n + 1}`,
      ).catch(
        (e: unknown) =>
          ({
            status: 'failed',
            reason: `no answer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
            retryable: true,
          }) as const,
      );
      await inTransaction(pool, (c) =>
        c.query(
          `INSERT INTO report_sends (booking_id, channel, try, sent_to, status, retryable, detail, at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
          [
            bookingId,
            channel,
            n + 1,
            to,
            result.status,
            result.status === 'failed' && result.retryable,
            `re-sent by ${by.name}: ${result.status === 'sent' ? result.providerRef : result.reason}`.slice(
              0,
              300,
            ),
            now,
          ],
        ),
      );
      return result.status;
    } finally {
      await lock
        .query("SELECT pg_advisory_unlock(hashtext('report-sends'))")
        .catch((e: unknown) => {
          broken = e instanceof Error ? e : new Error(String(e));
        });
    }
  } finally {
    lock.release(broken);
  }
}
