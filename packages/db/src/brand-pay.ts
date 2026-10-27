// P5.6 in the database: review and pay on the brand portal. The booking line by line (each area and
// day with its hours, bikes and price), the deal discount, GST split as it will be invoiced (CGST and
// SGST in RECALL's state, IGST elsewhere) and the total; the five plain rules to agree to. Paying
// records the agreement (once, with the version agreed), checks the booking can still start (the
// portal's lead days) and makes the payment link (UPI, card or net banking at the provider), as staff
// links are made (P3.8.2): the bikes are kept from then, and the GST invoice is made when it is paid.
import type { PaymentsAdapter } from '@recall/adapters';
import {
  bookingTerms,
  isoAt,
  priceBookAt,
  splitGst,
  TERMS_VERSION,
  type BookingState,
  type Term,
} from '@recall/domain';
import type { Pool } from 'pg';
import { bookingState, CapacityError, priceBooks, StepRace } from './bookings.js';
import { sendForPayment, type SentLink } from './booking-desk.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';
import { threadFromBrandPortal } from './support.js';

/** A booking staff are still writing (made in admin, still a draft) is not the brand's to see, pay
 * or give ads until staff send it (P7.1). For a query on `bookings b`. */
export const NOT_STAFF_DRAFT = `NOT (b.channel = 'admin' AND
  (SELECT e.state FROM booking_events e WHERE e.booking_id = b.booking_id
    ORDER BY e.seq DESC LIMIT 1) = 'draft')`;

type Q = Pick<Pool, 'query'>;
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

export interface ReviewLine {
  readonly area: string;
  readonly day: string;
  /** Start hours, India time (24 = midnight, 25 = 1 am). */
  readonly hours: readonly number[];
  readonly bikes: number;
  readonly band: string;
  readonly paisePerBikeHour: number;
  readonly paise: number;
}

export interface ReviewPage {
  readonly bookingId: string;
  readonly state: BookingState;
  readonly trial: boolean;
  readonly repeatMonths: number;
  readonly lines: readonly ReviewLine[];
  readonly bikeHours: number;
  readonly plays: number;
  readonly listPaise: number;
  readonly discountPaise: number;
  readonly subtotalPaise: number;
  readonly gst: { readonly cgst: number; readonly sgst: number; readonly igst: number };
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly firstHourAt: number;
  readonly adsDueAt: number;
  readonly terms: readonly Term[];
  readonly termsVersion: number;
  /** When this business agreed to the rules for this booking, if it has. */
  readonly agreedAt: number | null;
  /** GST in basis points (1800 = 18%), as invoiced. */
  readonly gstBp: number;
  /** Why it cannot be paid here now, in words for the brand; null when it can (or is paid). */
  readonly blocked: string | null;
}

interface Payable {
  readonly trial: boolean;
  readonly repeat_months: number;
  readonly channel: string;
  readonly first_hour_at: Date;
  readonly price_book_version: number;
}

/**
 * Why a booking cannot be paid on the portal now, or null. The same checks the payment makes, so
 * the page never offers a payment that will be refused.
 */
async function whyNotPayable(
  c: Q,
  bookingId: string,
  x: Payable,
  state: BookingState | undefined,
  now: number,
): Promise<{ readonly why: string; readonly code: string } | null> {
  if (x.trial) return { why: 'A free week needs no payment', code: 'trial' };
  if (state === 'cancelled')
    return { why: 'This campaign was cancelled: book again', code: 'cancelled' };
  if (state !== 'draft' && state !== 'awaiting-payment')
    return { why: 'This campaign is paid', code: 'paid' };
  // 6- and 12-month deals are taken forward by the sales team (Prateek, 27 Oct 2026).
  if (x.repeat_months > 1)
    return {
      why: `A ${x.repeat_months}-month deal is set up with our sales team: they will call you`,
      code: 'repeat-deal',
    };
  const book = priceBookAt(await priceBooks(c), isoAt(now));
  if (!book) return { why: 'Booking is not open yet: call us', code: 'no-price-book' };
  if (state === 'draft') {
    if (x.price_book_version !== book.version)
      return {
        why: 'Prices changed since you booked: book again for the new prices',
        code: 'prices-changed',
      };
    if (x.channel === 'portal' && secs(x.first_hour_at) < now + book.portalLeadDays * 86_400)
      return {
        why: `It now starts in less than ${book.portalLeadDays} days: book it again with a later start, or call us`,
        code: 'too-soon',
      };
  } else {
    // Waiting on a link: one that ran out cannot be paid (the booking is being let go).
    const live = await c.query(
      `SELECT 1 FROM payment_links l
        WHERE l.booking_id = $1 AND l.expires_at > to_timestamp($2)
          AND NOT EXISTS (SELECT 1 FROM payment_link_events e WHERE e.link_id = l.link_id
                           AND e.state IN ('paid', 'expired', 'cancelled'))`,
      [bookingId, now],
    );
    const any = await c.query('SELECT 1 FROM payment_links WHERE booking_id = $1', [bookingId]);
    if ((live.rowCount ?? 0) === 0 && (any.rowCount ?? 0) > 0)
      return { why: 'Its payment link ran out: book again', code: 'link-ran-out' };
  }
  return null;
}

/** A booking of this business, line by line, with its money and the rules; undefined if not its. */
export async function reviewPage(
  c: Q,
  brandId: string,
  bookingId: string,
  now: number,
): Promise<ReviewPage | undefined> {
  const b = await c.query<{
    trial: boolean;
    repeat_months: number;
    discount_paise: string;
    subtotal_paise: string;
    gst_paise: string;
    total_paise: string;
    first_hour_at: Date;
    ads_due_at: Date;
    price_book_version: number;
    channel: string;
  }>(
    `SELECT trial, repeat_months, discount_paise, subtotal_paise, gst_paise, total_paise,
            first_hour_at, ads_due_at, price_book_version, channel
       FROM bookings b WHERE booking_id = $1 AND brand_id = $2 AND ${NOT_STAFF_DRAFT}`,
    [bookingId, brandId],
  );
  const x = b.rows[0];
  if (!x) return undefined;
  const lines = await c.query<{
    name: string;
    day: string;
    start_hour: number;
    bikes: number;
    paise_per_bike_hour: string;
    paise: string;
    plays: number;
  }>(
    `SELECT av.name, bl.day::text, bl.start_hour, bl.bikes, bl.paise_per_bike_hour, bl.paise, bl.plays
       FROM booking_lines bl
       JOIN area_versions av ON av.area_id = bl.area_id AND av.version = bl.area_version
      WHERE bl.booking_id = $1 ORDER BY bl.day, av.name, bl.start_hour`,
    [bookingId],
  );
  const books = await priceBooks(c);
  const book =
    books.find((p) => p.version === x.price_book_version) ?? priceBookAt(books, isoAt(now));
  if (!book) throw new Refusal('Booking is not open yet: call us');
  // One row per area, day, bikes and price band (its hours listed).
  const bandOf = (h: number) => book.bands.find((p) => p.startHours.includes(h))?.name ?? '';
  const rows = new Map<
    string,
    {
      area: string;
      day: string;
      hours: number[];
      bikes: number;
      band: string;
      each: number;
      paise: number;
    }
  >();
  for (const l of lines.rows) {
    const band = bandOf(l.start_hour);
    const k = `${l.day}|${l.name}|${l.bikes}|${band}|${l.paise_per_bike_hour}`;
    const r = rows.get(k) ?? {
      area: l.name,
      day: l.day,
      hours: [],
      bikes: l.bikes,
      band,
      each: Number(l.paise_per_bike_hour),
      paise: 0,
    };
    r.hours.push(l.start_hour);
    r.paise += Number(l.paise);
    rows.set(k, r);
  }
  const tax = await c.query<{ state_code: string | null }>(
    'SELECT state_code FROM brand_tax_profiles WHERE brand_id = $1 ORDER BY set_at DESC LIMIT 1',
    [brandId],
  );
  const gstPaise = Number(x.gst_paise);
  const agreed = await c.query<{ at: Date }>(
    'SELECT max(at) AS at FROM booking_terms WHERE booking_id = $1 HAVING count(*) > 0',
    [bookingId],
  );
  // GST split by the price book in force now, as the invoice made on payment takes it.
  const current = priceBookAt(books, isoAt(now)) ?? book;
  const state = (await bookingState(c, bookingId)) ?? undefined;
  const blocked = await whyNotPayable(c, bookingId, x, state, now);
  const listPaise = lines.rows.reduce((n, l) => n + Number(l.paise), 0);
  return {
    bookingId,
    state: state ?? 'draft',
    trial: x.trial,
    repeatMonths: x.repeat_months,
    lines: [...rows.values()].map((r) => ({
      area: r.area,
      day: r.day,
      hours: r.hours,
      bikes: r.bikes,
      band: r.band,
      paisePerBikeHour: r.each,
      paise: r.paise,
    })),
    bikeHours: lines.rows.reduce((n, l) => n + l.bikes, 0),
    plays: lines.rows.reduce((n, l) => n + l.plays, 0),
    listPaise,
    discountPaise: Number(x.discount_paise),
    subtotalPaise: Number(x.subtotal_paise),
    gst: splitGst(
      gstPaise,
      current.taxes.supplierStateCode,
      tax.rows[0]?.state_code ?? current.taxes.supplierStateCode,
    ),
    gstBp: book.gstBp,
    blocked: blocked && blocked.code !== 'paid' ? blocked.why : null,
    gstPaise,
    totalPaise: Number(x.total_paise),
    firstHourAt: secs(x.first_hour_at),
    adsDueAt: secs(x.ads_due_at),
    terms: bookingTerms(book),
    termsVersion: TERMS_VERSION,
    agreedAt: agreed.rows[0] ? secs(agreed.rows[0].at) : null,
  };
}

/**
 * The brand agrees to the rules and pays: every check first, then the payment link is made (or the
 * live one given again), then the agreement is kept. Refused when the booking is not this
 * business's, is not waiting to be paid, is a monthly deal, has old prices, can no longer start
 * (the portal's lead days) or its link ran out.
 */
export async function payFromPortal(
  pool: Pool,
  payments: PaymentsAdapter,
  p: {
    readonly brandId: string;
    readonly bookingId: string;
    readonly by: string;
    readonly ip: string;
    readonly termsVersion: number;
  },
  now: number,
): Promise<SentLink> {
  const b = await pool.query<Payable>(
    `SELECT first_hour_at, channel, trial, repeat_months, price_book_version
       FROM bookings b WHERE booking_id = $1 AND brand_id = $2 AND ${NOT_STAFF_DRAFT}`,
    [p.bookingId, p.brandId],
  );
  const x = b.rows[0];
  if (!x) throw new Refusal('No such campaign', { code: 'no-booking' });
  if (p.termsVersion !== TERMS_VERSION)
    throw new Refusal('The rules have changed: read them again and tick the box', {
      code: 'terms-changed',
    });
  // Every check first: nothing is kept for a payment that is refused.
  const blocked = await whyNotPayable(
    pool,
    p.bookingId,
    x,
    await bookingState(pool, p.bookingId),
    now,
  );
  if (blocked) throw new Refusal(blocked.why, { code: blocked.code });
  try {
    const link = await sendForPayment(pool, payments, p.bookingId, p.by, now);
    // The agreement, kept once the payment is on its way (once per booking and rules version).
    await pool.query(
      `INSERT INTO booking_terms (booking_id, terms_version, accepted_by, ip, at)
       VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT (booking_id, terms_version) DO NOTHING`,
      [p.bookingId, p.termsVersion, p.by.slice(0, 254), p.ip.slice(0, 64), now],
    );
    return link;
  } catch (e) {
    // Hours sold to someone else since it was booked (a draft holds none): told plainly.
    if (e instanceof CapacityError)
      throw new Refusal('Some of these hours were sold meanwhile: book again with other hours', {
        code: 'sold-out',
      });
    if (e instanceof StepRace)
      throw new Refusal('This campaign just changed: open it again', { code: 'changed' });
    throw e;
  }
}

/**
 * P5.6: a 6- or 12-month deal goes to the sales team (Prateek, 27 Oct 2026): a support conversation
 * with the booking's numbers, once per booking. Returns its conversation id.
 */
export async function askSalesForDeal(
  pool: Pool,
  d: { readonly brandId: string; readonly bookingId: string; readonly contact: string },
  now: number,
): Promise<string> {
  const page = await reviewPage(pool, d.brandId, d.bookingId, now);
  if (!page) throw new Refusal('No such campaign', { code: 'no-booking' });
  if (page.repeatMonths <= 1)
    throw new Refusal('Only a 6- or 12-month deal goes to our sales team');
  return inTransaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deal:${d.bookingId}`]);
    const subject = `${page.repeatMonths}-month deal: booking ${d.bookingId}`;
    const before = await c.query<{ thread_id: string }>(
      `SELECT thread_id FROM support_threads WHERE party_kind = 'brand' AND party_id = $1
          AND subject = $2 LIMIT 1`,
      [d.brandId, subject],
    );
    if (before.rows[0]) return before.rows[0].thread_id;
    const days = [...new Set(page.lines.map((l) => l.day))];
    return threadFromBrandPortal(c, {
      brandId: d.brandId,
      contact: d.contact,
      subject,
      text: `Please call about a ${page.repeatMonths}-month deal. Booking ${d.bookingId}: ${page.bikeHours} bike-hours over ${days.length} days, ${page.lines
        .map((l) => l.area)
        .filter((a, i, all) => all.indexOf(a) === i)
        .join(
          ', ',
        )}; ${rupeesText(page.totalPaise)} with GST after the ${page.repeatMonths}-month discount.`,
      at: now,
    });
  });
}

const rupeesText = (p: number) => `₹${Math.round(p / 100).toLocaleString('en-IN')}`;
