// P3.8.2 in the database: staff booking for a brand. A draft is sent for payment (its bikes are
// then kept, after the limits are checked again) with a payment link that works `payLinkHours`
// and never past the first hour; the provider's signed message (or asking it) records the payment;
// an unpaid link that runs out cancels the booking so its bikes go back on sale. Money that arrives
// after a booking was cancelled is still recorded, for finance to return. Every step is on the
// booking's timeline, with staff notes.
import type { LinkStatus, PaymentEvent, PaymentsAdapter } from '@recall/adapters';
import { isoAt, priceBookAt, type BookingState } from '@recall/domain';
import type { Pool } from 'pg';
import { bookingState, moveBooking, priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

export interface SentLink {
  readonly linkId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly amountPaise: number;
}

/** The newest link of a booking, with what has happened to it, if any. */
async function latestLink(pool: Q, bookingId: string) {
  const r = await pool.query<{
    link_id: string;
    url: string;
    expires_at: Date;
    amount_paise: string;
    states: string[];
  }>(
    `SELECT l.link_id, l.url, l.expires_at, l.amount_paise,
            coalesce(array_agg(e.state) FILTER (WHERE e.state IS NOT NULL), '{}') AS states
       FROM payment_links l LEFT JOIN payment_link_events e USING (link_id)
      WHERE l.booking_id = $1
      GROUP BY l.link_id ORDER BY max(l.created_at) DESC LIMIT 1`,
    [bookingId],
  );
  return r.rows[0];
}

/**
 * Sends a booking for payment: a draft becomes awaiting payment (bikes kept, limits checked again,
 * prices still the ones in force), then a payment link is made. Asking again while it waits gives
 * the same link (a lost answer, a double click), never a second one.
 */
export async function sendForPayment(
  pool: Pool,
  payments: PaymentsAdapter,
  bookingId: string,
  by: string,
  now: number,
): Promise<SentLink> {
  const b = await pool.query<{
    brand_id: string;
    total_paise: string;
    first_hour_at: Date;
    trial: boolean;
  }>('SELECT brand_id, total_paise, first_hour_at, trial FROM bookings WHERE booking_id = $1', [
    bookingId,
  ]);
  const booking = b.rows[0];
  if (!booking) throw new Refusal(`No booking ${bookingId}`);
  if (booking.trial) throw new Refusal('A free trial needs no payment');
  const total = Number(booking.total_paise);
  if (total <= 0) throw new Refusal('Nothing to pay');
  const state = await bookingState(pool, bookingId);
  if (state === 'draft')
    await moveBooking(pool, bookingId, 'awaiting-payment', { by, actor: 'admin' }, now).catch(
      (e: unknown) => {
        // The rules' own refusals (prices changed, first hour started) are for the person asking.
        if (e instanceof Error && !(e as { code?: string }).code) throw new Refusal(e.message);
        throw e;
      },
    );
  else if (state !== 'awaiting-payment')
    throw new Refusal(`This booking is ${state ?? 'unknown'}: no payment link is needed`);
  const known = await latestLink(pool, bookingId);
  if (known && known.states.length === 0)
    return {
      linkId: known.link_id,
      url: known.url,
      expiresAt: secs(known.expires_at),
      amountPaise: Number(known.amount_paise),
    };
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  const hours = book?.payLinkHours ?? 24;
  const expiresAt = Math.min(now + hours * 3600, secs(booking.first_hour_at));
  const contact = await pool.query<{ phone: string | null; email: string | null }>(
    'SELECT phone, email FROM brand_contacts WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1',
    [booking.brand_id],
  );
  const c = contact.rows[0];
  const link = await payments.createLink({
    linkKey: `${bookingId}#${total}`,
    bookingId,
    amountPaise: total,
    description: `RECALL booking ${bookingId}`,
    ...(c?.phone ? { phone: c.phone } : {}),
    ...(c?.email ? { email: c.email } : {}),
    expiresAt,
  });
  await inTransaction(pool, (tx) =>
    tx.query(
      `INSERT INTO payment_links (link_id, booking_id, amount_paise, url, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, to_timestamp($7)) ON CONFLICT (link_id) DO NOTHING`,
      [link.linkId, bookingId, total, link.url, expiresAt, by, now],
    ),
  );
  return { linkId: link.linkId, url: link.url, expiresAt, amountPaise: total };
}

export type PaymentOutcome = 'paid' | 'already' | 'paid-late' | 'waiting' | 'expired' | 'unknown';

/** Records what a link's status says (from the provider's message or from asking it). */
export async function applyLinkStatus(
  pool: Pool,
  linkId: string,
  status: LinkStatus,
  now: number,
): Promise<PaymentOutcome> {
  const r = await pool.query<{ booking_id: string; amount_paise: string }>(
    'SELECT booking_id, amount_paise FROM payment_links WHERE link_id = $1',
    [linkId],
  );
  const link = r.rows[0];
  if (!link) return 'unknown';
  const bookingId = link.booking_id;
  const record = (state: string, paymentId: string | null, at: number) =>
    inTransaction(pool, (tx) =>
      tx.query(
        `INSERT INTO payment_link_events (link_id, state, payment_id, at)
         VALUES ($1, $2, $3, to_timestamp($4)) ON CONFLICT DO NOTHING`,
        [linkId, state, paymentId, at],
      ),
    );
  if (status.state === 'created') return 'waiting';
  if (status.state !== 'paid') {
    await record(status.state, null, now);
    if ((await bookingState(pool, bookingId)) === 'awaiting-payment')
      await moveBooking(
        pool,
        bookingId,
        'cancelled',
        { by: 'payments', actor: 'system', reason: `payment link ${status.state}, not paid` },
        now,
      ).catch(() => undefined); // the first hour may have started: it stays awaiting payment, unpaid
    return 'expired';
  }
  const state: BookingState | undefined = await bookingState(pool, bookingId);
  if (state === 'awaiting-payment') {
    await moveBooking(
      pool,
      bookingId,
      'paid',
      { by: 'payments', actor: 'system', paymentId: status.paymentId },
      status.paidAt,
    );
    await record('paid', status.paymentId, status.paidAt);
    return 'paid';
  }
  if (state === 'cancelled') {
    // The brand paid after the booking was cancelled: kept on record (when we learned of it) for
    // finance to send back.
    await record('paid-late', status.paymentId, now);
    return 'paid-late';
  }
  await record('paid', status.paymentId, status.paidAt);
  return 'already';
}

/** A provider's message: trusted only when its signature checks out. */
export async function paymentMessage(
  pool: Pool,
  payments: PaymentsAdapter,
  rawBody: string,
  signature: string,
  now: number,
): Promise<PaymentOutcome | 'forged'> {
  const e: PaymentEvent | null = payments.verifyEvent(rawBody, signature);
  if (!e) return 'forged';
  return applyLinkStatus(pool, e.linkId, e.status, now);
}

/** Asks the provider about a booking's newest link (staff pressing "Check payment"). */
export async function checkPayment(
  pool: Pool,
  payments: PaymentsAdapter,
  bookingId: string,
  now: number,
): Promise<PaymentOutcome> {
  const l = await latestLink(pool, bookingId);
  if (!l) return 'unknown';
  return applyLinkStatus(pool, l.link_id, await payments.status(l.link_id), now);
}

/**
 * Every link that ran out unpaid: asked once more (a payment may have just arrived), then its
 * booking is cancelled and the bikes go back on sale. Safe to run as often as wanted.
 */
export async function expireUnpaid(
  pool: Pool,
  payments: PaymentsAdapter,
  now: number,
): Promise<string[]> {
  const r = await pool.query<{ link_id: string; booking_id: string }>(
    `SELECT l.link_id, l.booking_id FROM payment_links l
      WHERE l.expires_at <= to_timestamp($1)
        AND NOT EXISTS (SELECT 1 FROM payment_link_events e WHERE e.link_id = l.link_id)
        AND (SELECT state FROM booking_events be WHERE be.booking_id = l.booking_id
              ORDER BY seq DESC LIMIT 1) = 'awaiting-payment'`,
    [now],
  );
  const cancelled: string[] = [];
  for (const x of r.rows) {
    const s = await payments.status(x.link_id);
    // The provider may still say "created" for a moment past the end: the link's end decides.
    const out = await applyLinkStatus(
      pool,
      x.link_id,
      s.state === 'created' ? { state: 'expired' } : s,
      now,
    );
    if (out === 'expired') {
      await payments.cancelLink(x.link_id);
      cancelled.push(x.booking_id);
    }
  }
  return cancelled;
}

/** Cancels a booking before its first hour, with why; an open payment link is stopped. */
export async function cancelBooking(
  pool: Pool,
  payments: PaymentsAdapter,
  bookingId: string,
  by: string,
  reason: string,
  now: number,
): Promise<void> {
  if (reason.trim().length < 3) throw new Refusal('Give a reason (3 to 200 characters)');
  const state = await bookingState(pool, bookingId);
  if (!state) throw new Refusal(`No booking ${bookingId}`);
  await moveBooking(
    pool,
    bookingId,
    'cancelled',
    { by, actor: 'admin', reason: reason.trim() },
    now,
  ).catch((e: unknown) => {
    if (e instanceof Error && !(e as { code?: string }).code) throw new Refusal(e.message);
    throw e;
  });
  const l = await latestLink(pool, bookingId);
  if (l && l.states.length === 0) {
    await payments.cancelLink(l.link_id);
    await applyLinkStatus(pool, l.link_id, await payments.status(l.link_id), now);
  }
}

export async function addBookingNote(
  pool: Pool,
  bookingId: string,
  note: string,
  by: string,
  now: number,
): Promise<void> {
  const text = note.trim();
  if (text.length < 1 || text.length > 2000) throw new Refusal('A note is 1 to 2,000 characters');
  if (!(await bookingState(pool, bookingId))) throw new Refusal(`No booking ${bookingId}`);
  await inTransaction(pool, (tx) =>
    tx.query(
      'INSERT INTO booking_notes (booking_id, note, by, at) VALUES ($1, $2, $3, to_timestamp($4))',
      [bookingId, text, by, now],
    ),
  );
}

export interface TimelineItem {
  readonly at: number;
  readonly kind: 'step' | 'link' | 'payment' | 'note';
  readonly text: string;
  readonly by: string | null;
}

export interface BookingView {
  readonly bookingId: string;
  readonly brandId: string;
  readonly state: BookingState;
  readonly channel: 'portal' | 'admin';
  readonly trial: boolean;
  readonly repeatMonths: number;
  readonly holdId: string | null;
  readonly priceBookVersion: number;
  readonly subtotalPaise: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly firstHourAt: number;
  readonly adsDueAt: number;
  readonly lines: readonly {
    areaId: string;
    date: string;
    startHour: number;
    bikes: number;
    paise: number;
  }[];
  readonly link: (SentLink & { states: readonly string[] }) | null;
  readonly timeline: readonly TimelineItem[];
}

const STEP_TEXT: Record<string, string> = {
  draft: 'Draft made',
  'awaiting-payment': 'Sent for payment (bikes kept)',
  paid: 'Paid',
  'ads-approved': 'Ads approved',
  running: 'Running',
  done: 'Done',
  'report-sent': 'Report sent',
  cancelled: 'Cancelled',
  'ads-missing': 'Ads missing',
};

/** One booking with its lines, payment link and everything that happened to it, oldest first. */
export async function bookingView(pool: Q, bookingId: string): Promise<BookingView | undefined> {
  const b = await pool.query<{
    brand_id: string;
    channel: 'portal' | 'admin';
    trial: boolean;
    repeat_months: number;
    hold_id: string | null;
    price_book_version: number;
    subtotal_paise: string;
    gst_paise: string;
    total_paise: string;
    first_hour_at: Date;
    ads_due_at: Date;
  }>('SELECT * FROM bookings WHERE booking_id = $1', [bookingId]);
  const x = b.rows[0];
  if (!x) return undefined;
  const [lines, steps, links, payEvents, notes] = await Promise.all([
    pool.query<{ area_id: string; day: string; start_hour: number; bikes: number; paise: string }>(
      `SELECT area_id, day::text, start_hour, bikes, paise FROM booking_lines WHERE booking_id = $1
        ORDER BY day, start_hour, area_id`,
      [bookingId],
    ),
    pool.query<{ state: BookingState; at: Date; by_who: string; reason: string | null }>(
      'SELECT state, at, by_who, reason FROM booking_events WHERE booking_id = $1 ORDER BY seq',
      [bookingId],
    ),
    pool.query<{
      link_id: string;
      url: string;
      expires_at: Date;
      amount_paise: string;
      created_by: string;
      created_at: Date;
    }>('SELECT * FROM payment_links WHERE booking_id = $1 ORDER BY created_at', [bookingId]),
    pool.query<{ link_id: string; state: string; payment_id: string | null; at: Date }>(
      `SELECT e.* FROM payment_link_events e JOIN payment_links l USING (link_id)
        WHERE l.booking_id = $1 ORDER BY e.at`,
      [bookingId],
    ),
    pool.query<{ note: string; by: string; at: Date }>(
      'SELECT note, by, at FROM booking_notes WHERE booking_id = $1 ORDER BY id',
      [bookingId],
    ),
  ]);
  const last = steps.rows[steps.rows.length - 1];
  if (!last) return undefined;
  const timeline: TimelineItem[] = [
    ...steps.rows.map((s) => ({
      at: secs(s.at),
      kind: 'step' as const,
      text: `${STEP_TEXT[s.state] ?? s.state}${s.reason ? `: ${s.reason}` : ''}`,
      by: s.by_who,
    })),
    ...links.rows.map((l) => ({
      at: secs(l.created_at),
      kind: 'link' as const,
      text: `Payment link sent (${l.link_id}), works until ${isoAt(secs(l.expires_at))}`,
      by: l.created_by,
    })),
    ...payEvents.rows.map((e) => ({
      at: secs(e.at),
      kind: 'payment' as const,
      text:
        e.state === 'paid'
          ? `Payment received (${e.payment_id ?? ''})`
          : e.state === 'paid-late'
            ? `Paid after the booking was cancelled (${e.payment_id ?? ''}): finance to return it`
            : `Payment link ${e.state}`,
      by: null,
    })),
    ...notes.rows.map((n) => ({ at: secs(n.at), kind: 'note' as const, text: n.note, by: n.by })),
  ].sort((a, c) => a.at - c.at);
  const l = links.rows[links.rows.length - 1];
  return {
    bookingId,
    brandId: x.brand_id,
    state: last.state,
    channel: x.channel,
    trial: x.trial,
    repeatMonths: x.repeat_months,
    holdId: x.hold_id,
    priceBookVersion: x.price_book_version,
    subtotalPaise: Number(x.subtotal_paise),
    gstPaise: Number(x.gst_paise),
    totalPaise: Number(x.total_paise),
    firstHourAt: secs(x.first_hour_at),
    adsDueAt: secs(x.ads_due_at),
    lines: lines.rows.map((r) => ({
      areaId: r.area_id,
      date: r.day,
      startHour: r.start_hour,
      bikes: r.bikes,
      paise: Number(r.paise),
    })),
    link: l
      ? {
          linkId: l.link_id,
          url: l.url,
          expiresAt: secs(l.expires_at),
          amountPaise: Number(l.amount_paise),
          states: payEvents.rows.filter((e) => e.link_id === l.link_id).map((e) => e.state),
        }
      : null,
    timeline,
  };
}
