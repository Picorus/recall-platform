// P1.9.2: sending each final report to the brand on WhatsApp (a link) and email (the page and the
// PDF), once. Each channel and address is sent with the same key every try, so it never arrives
// twice; a passing failure is tried again 30 minutes later, up to 3 tries; a wrong address is not,
// until staff set a new one (which gets its own tries). Once every channel has been sent, or given
// up with at least one sent, the booking moves to report-sent.
import type { MessagesAdapter } from '@recall/adapters';
import {
  DEFAULT_SETTINGS,
  fillWording,
  reportPeriod,
  reportSummary,
  type CampaignReport,
  type Wording,
} from '@recall/domain';
import type { Pool } from 'pg';
import { moveBooking } from './bookings.js';
import { inTransaction } from './makeups.js';
import { setting } from './settings.js';

export const MAX_REPORT_TRIES = 3;
/** A passing failure is tried again after this long, so a short outage does not use up the tries. */
export const REPORT_RETRY_SECONDS = 30 * 60;
const PHONE = /^\+91[6-9]\d{9}$/;
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,24}$/;

/** Sets where a brand's reports and messages go (latest wins; nothing is overwritten). */
export async function setBrandContact(
  pool: Pool,
  brandId: string,
  contact: { readonly phone?: string; readonly email?: string },
  by: string,
): Promise<void> {
  if (contact.phone !== undefined && !PHONE.test(contact.phone))
    throw new Error('phone must be +91 and a 10-digit mobile number');
  if (contact.email !== undefined && !EMAIL.test(contact.email))
    throw new Error('email does not look right');
  if (contact.phone === undefined && contact.email === undefined)
    throw new Error('a phone or an email is needed');
  await inTransaction(pool, (c) =>
    c.query('INSERT INTO brand_contacts (brand_id, phone, email, set_by) VALUES ($1, $2, $3, $4)', [
      brandId,
      contact.phone ?? null,
      contact.email ?? null,
      by,
    ]),
  );
}

/** How the page and the PDF are made (the workers' renderers; passed in, so this stays testable). */
export interface ReportRender {
  /** Where the brand sees the report in its portal. */
  readonly link: (bookingId: string) => string;
  readonly html: (r: CampaignReport) => string;
  readonly pdf: (r: CampaignReport) => Promise<Uint8Array>;
}

export interface ReportsSent {
  /** Bookings moved to report-sent in this run. */
  readonly sent: readonly string[];
  /** Brands with no phone or email: staff must add one. */
  readonly noContact: readonly string[];
  /** Reports that could not reach the brand on any channel after every try: staff must call. */
  readonly undelivered: readonly string[];
}

export type Channel = 'whatsapp' | 'email';

/**
 * Sends every built report not yet sent (P1.9.2). Safe to run as often as wanted, from several
 * places: runs take turns (one lock for the whole run, since messages leave the system).
 */
export async function sendDueReports(
  pool: Pool,
  messages: MessagesAdapter,
  render: ReportRender,
  now: number,
): Promise<ReportsSent> {
  const lock = await pool.connect();
  const sent: string[] = [];
  const noContact: string[] = [];
  const undelivered: string[] = [];
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('report-sends'))");
    const due = await pool.query<{ booking_id: string; brand_id: string; report: CampaignReport }>(
      `SELECT r.booking_id, b.brand_id, r.report
         FROM campaign_reports r JOIN bookings b USING (booking_id)
         JOIN LATERAL (SELECT state FROM booking_events e WHERE e.booking_id = r.booking_id
                        ORDER BY seq DESC LIMIT 1) s ON true
        WHERE s.state = 'done' ORDER BY r.built_at, r.booking_id`,
    );
    const wording = (await setting(pool, 'messages')).reportReady;
    for (const d of due.rows) {
      const contact = await pool.query<{ phone: string | null; email: string | null }>(
        `SELECT phone, email FROM brand_contacts WHERE brand_id = $1 AND set_at <= to_timestamp($2)
          ORDER BY set_at DESC LIMIT 1`,
        [d.brand_id, now],
      );
      const to: Partial<Record<Channel, string>> = {};
      if (contact.rows[0]?.phone) to.whatsapp = contact.rows[0].phone;
      if (contact.rows[0]?.email) to.email = contact.rows[0].email;
      const channels = (['whatsapp', 'email'] as const).filter((ch) => to[ch] !== undefined);
      if (channels.length === 0) {
        noContact.push(d.booking_id);
        continue;
      }
      const state: Record<Channel, 'sent' | 'open' | 'given up'> = {
        whatsapp: 'given up',
        email: 'given up',
      };
      for (const ch of channels) {
        const address = to[ch] ?? '';
        const tries = await pool.query<{
          try: number;
          status: string;
          retryable: boolean;
          sent_to: string;
          at: string;
        }>(
          `SELECT try, status, retryable, sent_to, extract(epoch FROM at)::bigint AS at
             FROM report_sends WHERE booking_id = $1 AND channel = $2 ORDER BY try`,
          [d.booking_id, ch],
        );
        if (tries.rows.some((t) => t.status === 'sent')) {
          state[ch] = 'sent';
          continue;
        }
        // Tries count per address: a new address set by staff starts again.
        const mine = tries.rows.filter((t) => t.sent_to === address);
        const last = mine[mine.length - 1];
        if (last && (!last.retryable || mine.length >= MAX_REPORT_TRIES)) continue;
        if (last && now < Number(last.at) + REPORT_RETRY_SECONDS) {
          state[ch] = 'open';
          continue;
        }
        const result = await sendReportMessage(
          messages,
          ch,
          address,
          d.report,
          render,
          undefined,
          wording,
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
              d.booking_id,
              ch,
              tries.rows.length + 1,
              address,
              result.status,
              result.status === 'failed' && result.retryable,
              result.status === 'sent' ? result.providerRef : result.reason,
              now,
            ],
          ),
        );
        state[ch] =
          result.status === 'sent'
            ? 'sent'
            : result.retryable && mine.length + 1 < MAX_REPORT_TRIES
              ? 'open'
              : 'given up';
      }
      const states = channels.map((ch) => state[ch]);
      if (states.includes('open')) continue;
      if (states.includes('sent')) {
        await moveBooking(
          pool,
          d.booking_id,
          'report-sent',
          { by: 'system', actor: 'system' },
          now,
        );
        sent.push(d.booking_id);
      } else undelivered.push(d.booking_id);
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('report-sends'))").catch(() => undefined);
    lock.release();
  }
  return { sent, noContact, undelivered };
}

/**
 * Sends one report on one channel. `key` (P3.14.1: a staff re-send has its own) defaults to one per
 * address: a new address is a new message, never the old one replayed.
 */
export async function sendReportMessage(
  messages: MessagesAdapter,
  channel: Channel,
  to: string,
  r: CampaignReport,
  render: ReportRender,
  key = `report:${r.bookingId}:${channel}:${to}`,
  wording: Wording = DEFAULT_SETTINGS.messages.reportReady,
) {
  const link = render.link(r.bookingId);
  const summary = reportSummary(r);
  const values = {
    booking: r.bookingId,
    period: reportPeriod(r),
    summary: summary.join('\n'),
    link,
  };
  if (channel === 'whatsapp')
    return messages.send({
      channel,
      key,
      to,
      template: wording.whatsappTemplate,
      params: [r.bookingId, reportPeriod(r), summary[0] ?? '', link],
    });
  return messages.send({
    channel,
    key,
    to,
    // The wording is a setting (P3.17); a value never carries a line break into the subject.
    subject: fillWording(wording.emailSubject, values)
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 200),
    text: fillWording(wording.emailText, values),
    html: render.html(r),
    attachments: [
      {
        name: `RECALL-report-${r.bookingId}.pdf`,
        contentType: 'application/pdf',
        bytes: await render.pdf(r),
      },
    ],
  });
}
