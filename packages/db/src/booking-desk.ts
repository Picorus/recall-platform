// P3.8.2 in the database: staff booking for a brand. A draft is sent for payment (its bikes are
// then kept, after the limits are checked again) with a payment link that works `payLinkHours`
// and never past the first hour; the provider's signed message (or asking it) records the payment;
// an unpaid link that runs out cancels the booking so its bikes go back on sale. Money that cannot
// be kept (paid after a cancellation, a wrong amount, a second payment, an unknown link) is put on
// the books as owed back, for finance. Every step is on the booking's timeline, with staff notes.
//
// Races (review P3.8.2): every step is applied only if the booking is still in the step the caller
// saw (`expectFrom`, checked under the booking's lock), so an expiry can never cancel a booking a
// payment has just paid, and a payment can never land on a booking cancelled in between.
import type { LinkStatus, PaymentEvent, PaymentsAdapter } from '@recall/adapters';
import { isoAt, moneyToReturn, priceBookAt, type BookingState } from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { bookingState, CapacityError, moveBooking, priceBooks, StepRace } from './bookings.js';
import { postEntry } from './ledger.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

/** A link must work at least this long, or the brand cannot pay in time (providers refuse less). */
export const MIN_LINK_SECONDS = 15 * 60;
/** A link that ran out is acted on this long after its end: a payment started in time may finish. */
export const EXPIRY_GRACE_SECONDS = 2 * 60;
/** A link the provider cannot report on is treated as run out this long after its end. */
export const PROVIDER_SILENT_SECONDS = 60 * 60;
/** A booking sent for payment with no link made (a crash, the provider down) is let go after this. */
export const NO_LINK_SECONDS = 10 * 60;

export interface SentLink {
  readonly linkId: string;
  readonly url: string;
  readonly expiresAt: number;
  readonly amountPaise: number;
}

/** The rules' own refusals (prices changed, first hour started) are for the person asking. */
function asRefusal(e: unknown): never {
  if (e instanceof CapacityError || e instanceof StepRace) throw e;
  if (e instanceof Error && !(e as { code?: string }).code) throw new Refusal(e.message);
  throw e;
}

/** A link is over once it was paid, ran out or was stopped (money owed back does not end it). */
const ended = (states: readonly string[]) =>
  states.some((x) => x === 'paid' || x === 'expired' || x === 'cancelled');

/** A booking's links, newest first, with what has happened to each. */
async function linksOf(pool: Q, bookingId: string) {
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
      GROUP BY l.link_id ORDER BY max(l.created_at) DESC, l.link_id`,
    [bookingId],
  );
  return r.rows;
}

/**
 * Sends a booking for payment: a draft becomes awaiting payment (bikes kept, limits checked again,
 * prices still the ones in force), then a payment link is made. Asking again while the link works
 * gives the same link (a lost answer, a double click), never a second one.
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
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  const expiresAt = Math.min(now + (book?.payLinkHours ?? 24) * 3600, secs(booking.first_hour_at));
  const links = await linksOf(pool, bookingId);
  const state = await bookingState(pool, bookingId);
  if (state === 'awaiting-payment') {
    const live = links.find((l) => !ended(l.states) && secs(l.expires_at) > now);
    if (live)
      return {
        linkId: live.link_id,
        url: live.url,
        expiresAt: secs(live.expires_at),
        amountPaise: Number(live.amount_paise),
      };
    if (links.length > 0)
      throw new Refusal(
        'Its payment link ran out: the booking is being cancelled. Make a new one.',
      );
    // Sent for payment but no link was made (the provider did not answer): make it now.
  } else if (state !== 'draft')
    throw new Refusal(`This booking is ${state ?? 'unknown'}: no payment link is needed`);
  if (expiresAt - now < MIN_LINK_SECONDS)
    throw new Refusal('Too close to the first hour to pay by link (it needs 15 minutes or more)');
  if (state === 'draft') {
    try {
      await moveBooking(
        pool,
        bookingId,
        'awaiting-payment',
        { by, actor: 'admin', expectFrom: 'draft' },
        now,
      );
    } catch (e) {
      // A second press while the first was sending: carry on with the same link.
      if (!(e instanceof StepRace && e.now === 'awaiting-payment')) asRefusal(e);
    }
  }
  const contact = await pool.query<{ phone: string | null; email: string | null }>(
    'SELECT phone, email FROM brand_contacts WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1',
    [booking.brand_id],
  );
  const c = contact.rows[0];
  const link = await payments.createLink({
    // The same for a repeat of this attempt; a new attempt (after a lost link) gets a new link.
    linkKey: `${bookingId}#${total}#${links.length + 1}`,
    bookingId,
    amountPaise: total,
    description: `RECALL booking ${bookingId}`,
    ...(c?.phone ? { phone: c.phone } : {}),
    ...(c?.email ? { email: c.email } : {}),
    expiresAt,
  });
  // Filed under the booking's lock, and only while it still waits for payment: a booking cancelled
  // meanwhile (its link took too long to make) must never get a working link (review P3.8.2).
  const filed = await inTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`booking:${bookingId}`]);
    const st = await tx.query<{ state: BookingState }>(
      'SELECT state FROM booking_events WHERE booking_id = $1 ORDER BY seq DESC LIMIT 1',
      [bookingId],
    );
    if (st.rows[0]?.state !== 'awaiting-payment') return 'moved' as const;
    await tx.query(
      `INSERT INTO payment_links (link_id, booking_id, amount_paise, url, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4, to_timestamp($5), $6, to_timestamp($7)) ON CONFLICT (link_id) DO NOTHING`,
      [link.linkId, bookingId, total, link.url, expiresAt, by, now],
    );
    const kept = await tx.query<{ booking_id: string; amount_paise: string; expires_at: Date }>(
      'SELECT booking_id, amount_paise, expires_at FROM payment_links WHERE link_id = $1',
      [link.linkId],
    );
    return kept.rows[0];
  });
  if (filed === 'moved') {
    await payments.cancelLink(link.linkId).catch(() => undefined);
    throw new Refusal('This booking was cancelled while its link was being made');
  }
  // A link id already filed under another booking must never be handed out (paying it would settle
  // the other booking).
  if (!filed || filed.booking_id !== bookingId || Number(filed.amount_paise) !== total)
    throw new Error(`Payment provider gave link ${link.linkId}, already used for another booking`);
  return {
    linkId: link.linkId,
    url: link.url,
    expiresAt: secs(filed.expires_at),
    amountPaise: total,
  };
}

export type PaymentOutcome =
  'paid' | 'already' | 'paid-late' | 'wrong-amount' | 'waiting' | 'expired' | 'unknown';

/** Records money that cannot be kept: its event on the link and the ledger entry, once. */
async function moneyBack(
  pool: Pool,
  l: { linkId: string; bookingId: string; brandId: string },
  state: 'paid-late' | 'wrong-amount',
  paid: { paymentId: string; amountPaise: number },
  why: string,
  at: number,
): Promise<'already' | 'recorded'> {
  return inTransaction(pool, async (tx) => {
    const r = await tx.query(
      `INSERT INTO payment_link_events (link_id, state, payment_id, amount_paise, at)
       VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT DO NOTHING`,
      [l.linkId, state, paid.paymentId, paid.amountPaise, at],
    );
    if (r.rowCount === 0) return 'already';
    if (paid.amountPaise > 0)
      await postEntry(
        tx,
        moneyToReturn({
          paymentId: paid.paymentId,
          ref: l.bookingId,
          brandId: l.brandId,
          amount: paid.amountPaise,
          why,
          at,
        }),
        'payments',
      );
    return 'recorded';
  });
}

/** Records what a link's status says (from the provider's message or from asking it). */
export async function applyLinkStatus(
  pool: Pool,
  linkId: string,
  status: LinkStatus,
  now: number,
): Promise<PaymentOutcome> {
  const r = await pool.query<{
    booking_id: string;
    amount_paise: string;
    brand_id: string;
  }>(
    `SELECT l.booking_id, l.amount_paise, b.brand_id
       FROM payment_links l JOIN bookings b USING (booking_id) WHERE l.link_id = $1`,
    [linkId],
  );
  const link = r.rows[0];
  if (!link) return 'unknown';
  const bookingId = link.booking_id;
  const l = { linkId, bookingId, brandId: link.brand_id };
  if (status.state === 'created') return 'waiting';
  if (status.state !== 'paid') {
    const linkEnded = (c: Pick<PoolClient, 'query'>) =>
      c.query(
        `INSERT INTO payment_link_events (link_id, state, at)
         VALUES ($1, $2, to_timestamp($3)) ON CONFLICT DO NOTHING`,
        [linkId, status.state, now],
      );
    try {
      // The booking is cancelled and the link marked ended in one step, or neither: a failure is
      // simply tried again by the next run (review P3.8.2).
      await moveBooking(
        pool,
        bookingId,
        'cancelled',
        {
          by: 'payments',
          actor: 'system',
          reason: `payment link ${status.state}, not paid`,
          expectFrom: 'awaiting-payment',
          alsoWrite: linkEnded,
        },
        now,
      );
    } catch (e) {
      if (!(e instanceof StepRace)) throw e;
      // Paid in between: nothing to cancel. Cancelled by staff in between: the link ended too.
      if (e.now !== 'cancelled') return 'already';
      await inTransaction(pool, linkEnded);
    }
    return 'expired';
  }
  // Recorded when we learn of it, so invoices keep their numbers in date order and books already
  // closed never change; the provider's own time is kept on the payment's record.
  const at = now;
  const paid = { paymentId: status.paymentId, amountPaise: status.amountPaise };
  if (status.amountPaise !== Number(link.amount_paise)) {
    const out = await moneyBack(
      pool,
      l,
      'wrong-amount',
      paid,
      `paid ${status.amountPaise} paise, link was for ${link.amount_paise}`,
      at,
    );
    return out === 'already' ? 'already' : 'wrong-amount';
  }
  const known = await pool.query<{ link_id: string; state: string }>(
    'SELECT link_id, state FROM payment_link_events WHERE payment_id = $1',
    [status.paymentId],
  );
  if (known.rows[0]) return 'already';
  try {
    await moveBooking(
      pool,
      bookingId,
      'paid',
      {
        by: 'payments',
        actor: 'system',
        paymentId: status.paymentId,
        expectFrom: 'awaiting-payment',
        // The link's record of the payment goes in with the booking step, never apart.
        alsoWrite: (c) =>
          c.query(
            `INSERT INTO payment_link_events (link_id, state, payment_id, amount_paise, at)
             VALUES ($1, 'paid', $2, $3, to_timestamp($4)) ON CONFLICT DO NOTHING`,
            [linkId, status.paymentId, status.amountPaise, Math.min(status.paidAt, now)],
          ),
      },
      at,
    );
  } catch (e) {
    if (!(e instanceof StepRace)) throw e;
    // The same payment may have just been applied by another path (its message and a check, or the
    // expiry run, at once): then it is this booking's payment, not money owed back.
    const mine = await pool.query('SELECT 1 FROM ledger_entries WHERE entry_id = $1', [
      `paid:${bookingId}:${status.paymentId}`,
    ]);
    if (mine.rowCount) return 'already';
    // Cancelled first, or already paid by another payment: this money is owed back.
    const why =
      e.now === 'cancelled' ? 'paid after the booking was cancelled' : `booking already ${e.now}`;
    const out = await moneyBack(pool, l, 'paid-late', paid, why, now);
    return out === 'already' ? 'already' : 'paid-late';
  }
  return 'paid';
}

/** A provider's message: trusted only when its signature checks out; never dropped. */
export async function paymentMessage(
  pool: Pool,
  payments: PaymentsAdapter,
  rawBody: string,
  signature: string,
  now: number,
): Promise<PaymentOutcome | 'forged'> {
  const e: PaymentEvent | null = payments.verifyEvent(rawBody, signature);
  if (!e) return 'forged';
  const out = await applyLinkStatus(pool, e.linkId, e.status, now);
  // A payment for a link we have no record of: kept for finance and on the books as owed back, in
  // one step and once per payment (other news about unknown links carries no money).
  if (out === 'unknown' && e.status.state === 'paid') {
    const st = e.status;
    await inTransaction(pool, async (tx) => {
      const r = await tx.query(
        `INSERT INTO payment_inbox (link_id, payment_id, event, received_at)
         VALUES ($1, $2, $3, to_timestamp($4)) ON CONFLICT DO NOTHING`,
        [e.linkId, st.paymentId, JSON.stringify(e), now],
      );
      if (r.rowCount && st.amountPaise > 0)
        await postEntry(
          tx,
          moneyToReturn({
            paymentId: st.paymentId,
            ref: e.linkId,
            amount: st.amountPaise,
            why: 'paid on a link we have no record of',
            at: now,
          }),
          'payments',
        );
    });
  }
  return out;
}

/** Asks the provider about a booking's newest link (staff pressing "Check payment"). */
export async function checkPayment(
  pool: Pool,
  payments: PaymentsAdapter,
  bookingId: string,
  now: number,
): Promise<PaymentOutcome> {
  const l = (await linksOf(pool, bookingId))[0];
  if (!l) return 'unknown';
  let status: LinkStatus;
  try {
    status = await payments.status(l.link_id);
  } catch {
    throw new Refusal('The payment provider did not answer. Try again in a minute.');
  }
  return applyLinkStatus(pool, l.link_id, status, now);
}

/**
 * Every link that ran out unpaid (a short grace after its end): stopped at the provider first, then
 * asked once more (a payment may have just completed) and acted on; then its booking is cancelled
 * and the bikes go back on sale. Bookings sent for payment with no link at all are let go too. Safe
 * to run as often as wanted; one link failing never stops the others.
 */
export async function expireUnpaid(
  pool: Pool,
  payments: PaymentsAdapter,
  now: number,
  log: (line: string) => void = (l) => console.error(l),
): Promise<string[]> {
  const cancelled: string[] = [];
  const r = await pool.query<{ link_id: string; booking_id: string; expires_at: Date }>(
    // Chosen by the booking (still waiting) and its newest link's end, never by what was recorded on
    // the link: a wrong amount, or a cancel that failed half-way, must not keep bikes for ever.
    `SELECT DISTINCT ON (l.booking_id) l.link_id, l.booking_id, l.expires_at FROM payment_links l
      WHERE (SELECT state FROM booking_events be WHERE be.booking_id = l.booking_id
              ORDER BY seq DESC LIMIT 1) = 'awaiting-payment'
      ORDER BY l.booking_id, l.created_at DESC`,
  );
  for (const x of r.rows.filter((y) => secs(y.expires_at) <= now - EXPIRY_GRACE_SECONDS)) {
    try {
      await payments.cancelLink(x.link_id).catch(() => undefined);
      let s: LinkStatus;
      try {
        s = await payments.status(x.link_id);
      } catch (e) {
        // The provider cannot say (a link it no longer knows): after an hour past the link's end the
        // booking is let go anyway; money that still comes is owed back.
        if (secs(x.expires_at) + PROVIDER_SILENT_SECONDS > now) throw e;
        log(`payments: no answer for link ${x.link_id}; letting its booking go`);
        s = { state: 'expired' };
      }
      // Still "created" after being stopped: the link's end decides.
      let out = await applyLinkStatus(
        pool,
        x.link_id,
        s.state === 'created' ? { state: 'expired' } : s,
        now,
      );
      // Whatever that recorded (a wrong amount owed back), a booking still waiting after its link's
      // end is let go: its bikes never stay kept unpaid.
      if ((await bookingState(pool, x.booking_id)) === 'awaiting-payment')
        out = await applyLinkStatus(pool, x.link_id, { state: 'expired' }, now);
      if (out === 'expired' && (await bookingState(pool, x.booking_id)) === 'cancelled')
        cancelled.push(x.booking_id);
    } catch (e) {
      log(`payments: could not expire link ${x.link_id}: ${(e as Error).message}`);
    }
  }
  const stuck = await pool.query<{ booking_id: string }>(
    `SELECT b.booking_id FROM bookings b
       JOIN LATERAL (SELECT state, at FROM booking_events e WHERE e.booking_id = b.booking_id
                      ORDER BY seq DESC LIMIT 1) s ON true
      WHERE s.state = 'awaiting-payment' AND s.at <= to_timestamp($1)
        AND NOT EXISTS (SELECT 1 FROM payment_links l WHERE l.booking_id = b.booking_id)`,
    [now - NO_LINK_SECONDS],
  );
  for (const x of stuck.rows) {
    try {
      await moveBooking(
        pool,
        x.booking_id,
        'cancelled',
        {
          by: 'payments',
          actor: 'system',
          reason: 'no payment link could be made',
          expectFrom: 'awaiting-payment',
        },
        now,
      );
      cancelled.push(x.booking_id);
    } catch (e) {
      if (!(e instanceof StepRace))
        log(`payments: could not cancel ${x.booking_id}: ${(e as Error).message}`);
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
  try {
    await moveBooking(
      pool,
      bookingId,
      'cancelled',
      { by, actor: 'admin', reason: reason.trim(), expectFrom: state },
      now,
    );
  } catch (e) {
    if (e instanceof StepRace)
      throw new Refusal(`${e.message}: reload and check before cancelling`);
    asRefusal(e);
  }
  const open = (await linksOf(pool, bookingId)).find((l) => !ended(l.states));
  if (open) {
    try {
      await payments.cancelLink(open.link_id);
      await applyLinkStatus(pool, open.link_id, await payments.status(open.link_id), now);
    } catch {
      // The booking is cancelled; the link runs out by itself, and a payment on it is owed back.
    }
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
    pool.query<{
      link_id: string;
      state: string;
      payment_id: string | null;
      amount_paise: string | null;
      at: Date;
    }>(
      `SELECT e.* FROM payment_link_events e JOIN payment_links l USING (link_id)
        WHERE l.booking_id = $1 ORDER BY e.id`,
      [bookingId],
    ),
    pool.query<{ note: string; by: string; at: Date }>(
      'SELECT note, by, at FROM booking_notes WHERE booking_id = $1 ORDER BY id',
      [bookingId],
    ),
  ]);
  const last = steps.rows[steps.rows.length - 1];
  if (!last) return undefined;
  // Same second: the steps that start a booking, then its link and payment events, then the steps
  // they cause (paid, cancelled), then money that could not be kept, then notes.
  const rank = (t: TimelineItem & { state?: string }): number => {
    if (t.kind === 'step') return t.state === 'draft' || t.state === 'awaiting-payment' ? 0 : 2;
    if (t.kind === 'payment') return t.state === 'paid-late' || t.state === 'wrong-amount' ? 3 : 1;
    return t.kind === 'note' ? 4 : 1;
  };
  const items: (TimelineItem & { state?: string })[] = [
    ...steps.rows.map((s) => ({
      at: secs(s.at),
      kind: 'step' as const,
      state: s.state,
      text: `${STEP_TEXT[s.state] ?? s.state}${s.reason ? `: ${s.reason}` : ''}`,
      by: s.by_who,
    })),
    ...links.rows.map((l) => ({
      at: secs(l.created_at),
      kind: 'link' as const,
      text: `Payment link sent (${l.link_id})`,
      by: l.created_by,
    })),
    ...payEvents.rows.map((e) => ({
      at: secs(e.at),
      kind: 'payment' as const,
      state: e.state,
      text:
        e.state === 'paid'
          ? `Payment received (${e.payment_id ?? ''})`
          : e.state === 'paid-late'
            ? `Money received that cannot be kept (${e.payment_id ?? ''}): finance to return it`
            : e.state === 'wrong-amount'
              ? `Wrong amount paid (${e.payment_id ?? ''}, ${e.amount_paise ?? 0} paise): finance to return it`
              : `Payment link ${e.state}`,
      by: null,
    })),
    ...notes.rows.map((n) => ({ at: secs(n.at), kind: 'note' as const, text: n.note, by: n.by })),
  ];
  const timeline: TimelineItem[] = items
    .map((t, i) => ({ t, i }))
    .sort((a, c) => a.t.at - c.t.at || rank(a.t) - rank(c.t) || a.i - c.i)
    .map(({ t }) => ({ at: t.at, kind: t.kind, text: t.text, by: t.by }));
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
