// P5.11: the brand's messages about a campaign, besides its report (P1.9.2): "booked and paid" once
// it is paid, and "your ads are due" 9 and 7 days before the start while no ads are chosen. Only
// these, on WhatsApp and email (rule v5.4: few messages). Each is sent once per channel and address
// with the same key every try (never twice); a passing failure is tried again 30 minutes later, up
// to 3 tries; a wrong address is not. Wording is a setting (Settings → Message wording).
import type { MessagesAdapter } from '@recall/adapters';
import { fillWording, rupees, type Wording } from '@recall/domain';
import type { Pool } from 'pg';
import { inTransaction } from './makeups.js';
import { MAX_REPORT_TRIES, REPORT_RETRY_SECONDS } from './report-sends.js';
import { setting } from './settings.js';

export type NoticeKind = 'paid' | 'ads-9' | 'ads-7';

/** A paid notice is sent only for payments this recent (never a flood of old ones on first run). */
export const PAID_NOTICE_WINDOW_SECONDS = 2 * 86_400;
const DAY = 86_400;

const dayText = (t: number) =>
  new Date((t + 19_800) * 1000).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const isoDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

interface Due {
  readonly bookingId: string;
  readonly brandId: string;
  readonly kind: NoticeKind;
  readonly firstHourAt: number;
  readonly adsDueAt: number;
  readonly totalPaise: number;
  readonly firstDay: string;
  readonly lastDay: string;
}

/** Messages due now (each kind of each booking until it is sent or given up on every channel). */
async function dueNotices(c: Pick<Pool, 'query'>, now: number): Promise<Due[]> {
  const r = await c.query<{
    booking_id: string;
    brand_id: string;
    kind: NoticeKind;
    first_at: string;
    due_at: string;
    total_paise: string;
    first_day: string;
    last_day: string;
  }>(
    `WITH b AS (
       SELECT b.booking_id, b.brand_id, b.trial, b.total_paise,
              extract(epoch FROM b.first_hour_at)::bigint AS first_at,
              extract(epoch FROM b.ads_due_at)::bigint AS due_at,
              (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
                ORDER BY seq DESC LIMIT 1) AS state,
              (SELECT extract(epoch FROM min(at))::bigint FROM booking_events e
                WHERE e.booking_id = b.booking_id AND e.state = 'paid') AS paid_at,
              coalesce((SELECT cardinality(s.ad_ids) FROM booking_ad_sets s
                         WHERE s.booking_id = b.booking_id ORDER BY version DESC LIMIT 1), 0) > 0
                AS has_ads
         FROM bookings b
        WHERE b.first_hour_at > to_timestamp($1)),
     k AS (
       SELECT booking_id, brand_id, total_paise, first_at, due_at, 'paid' AS kind FROM b
        WHERE NOT trial AND paid_at IS NOT NULL AND paid_at > $1 - $2
          AND state NOT IN ('cancelled', 'ads-missing')
       UNION ALL
       SELECT booking_id, brand_id, total_paise, first_at, due_at,
              CASE WHEN $1 >= first_at - 7 * ${DAY} THEN 'ads-7' ELSE 'ads-9' END
         FROM b
        -- One reminder at a time: the 9-day one only until the 7-day one is due. Only when the
        -- payment came before that day: paid later, "booked and paid" already says when ads are due.
        WHERE state = 'paid' AND NOT has_ads AND $1 >= first_at - 9 * ${DAY}
          AND paid_at <= CASE WHEN $1 >= first_at - 7 * ${DAY} THEN first_at - 7 * ${DAY}
                              ELSE first_at - 9 * ${DAY} END)
     SELECT k.booking_id, k.brand_id, k.kind, k.first_at, k.due_at, k.total_paise,
            l.first_day::text, l.last_day::text
       FROM k
       JOIN LATERAL (SELECT min(day) AS first_day, max(day) AS last_day FROM booking_lines
                      WHERE booking_id = k.booking_id) l ON true
      ORDER BY k.first_at, k.booking_id, k.kind`,
    [now, PAID_NOTICE_WINDOW_SECONDS],
  );
  return r.rows.map((x) => ({
    bookingId: x.booking_id,
    brandId: x.brand_id,
    kind: x.kind,
    firstHourAt: Number(x.first_at),
    adsDueAt: Number(x.due_at),
    totalPaise: Number(x.total_paise),
    firstDay: x.first_day,
    lastDay: x.last_day,
  }));
}

export interface NoticesSent {
  readonly sent: readonly string[];
  /** Brands with no phone or email: staff must add one. */
  readonly noContact: readonly string[];
}

/** Sends every message that is due. Safe to run as often as wanted: runs take turns. */
export async function sendDueNotices(
  pool: Pool,
  messages: MessagesAdapter,
  portalUrl: string,
  now: number,
): Promise<NoticesSent> {
  const lock = await pool.connect();
  const sent: string[] = [];
  const noContact = new Set<string>();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('brand-notices'))");
    const wordings = await setting(pool, 'messages');
    for (const d of await dueNotices(pool, now)) {
      const contact = await pool.query<{ phone: string | null; email: string | null }>(
        `SELECT phone, email FROM brand_contacts WHERE brand_id = $1 AND set_at <= to_timestamp($2)
          ORDER BY set_at DESC LIMIT 1`,
        [d.brandId, now],
      );
      const to = {
        whatsapp: contact.rows[0]?.phone ?? null,
        email: contact.rows[0]?.email ?? null,
      };
      if (!to.whatsapp && !to.email) {
        noContact.add(d.brandId);
        continue;
      }
      const brand = encodeURIComponent(d.brandId);
      const link =
        d.kind === 'paid'
          ? `${portalUrl}/campaigns?brand=${brand}`
          : `${portalUrl}/ads?brand=${brand}&booking=${encodeURIComponent(d.bookingId)}`;
      const values: Record<string, string> = {
        booking: d.bookingId,
        period:
          d.firstDay === d.lastDay
            ? isoDay(d.firstDay)
            : `${isoDay(d.firstDay)} – ${isoDay(d.lastDay)}`,
        total: rupees(d.totalPaise),
        adsDue: dayText(d.adsDueAt),
        start: dayText(d.firstHourAt),
        link,
      };
      const wording: Wording = d.kind === 'paid' ? wordings.bookedPaid : wordings.adsMissing;
      for (const ch of ['whatsapp', 'email'] as const) {
        const address = to[ch];
        if (!address) continue;
        const tries = await pool.query<{
          status: string;
          retryable: boolean;
          sent_to: string;
          at: string;
        }>(
          `SELECT status, retryable, sent_to, extract(epoch FROM at)::bigint AS at
             FROM brand_notices WHERE booking_id = $1 AND kind = $2 AND channel = $3 ORDER BY try`,
          [d.bookingId, d.kind, ch],
        );
        if (tries.rows.some((t) => t.status === 'sent')) continue;
        // Tries count per address: a new address set by staff starts again.
        const mine = tries.rows.filter((t) => t.sent_to === address);
        const last = mine[mine.length - 1];
        if (last && (!last.retryable || mine.length >= MAX_REPORT_TRIES)) continue;
        if (last && now < Number(last.at) + REPORT_RETRY_SECONDS) continue;
        const key = `notice:${d.kind}:${d.bookingId}:${ch}:${address}`;
        const result = await (
          ch === 'whatsapp'
            ? messages.send({
                channel: ch,
                key,
                to: address,
                template: wording.whatsappTemplate,
                params:
                  d.kind === 'paid'
                    ? [d.bookingId, values.period ?? '', values.total ?? '', link]
                    : [d.bookingId, values.start ?? '', values.adsDue ?? '', link],
              })
            : messages.send({
                channel: ch,
                key,
                to: address,
                subject: fillWording(wording.emailSubject, values)
                  .replace(/[\r\n]+/g, ' ')
                  .slice(0, 200),
                text: fillWording(wording.emailText, values),
                html: '',
                attachments: [],
              })
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
            `INSERT INTO brand_notices (booking_id, kind, channel, try, sent_to, status, retryable,
               detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9))`,
            [
              d.bookingId,
              d.kind,
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
        if (result.status === 'sent') sent.push(`${d.bookingId}:${d.kind}:${ch}`);
      }
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('brand-notices'))").catch(() => undefined);
    lock.release();
  }
  return { sent, noContact: [...noContact] };
}
