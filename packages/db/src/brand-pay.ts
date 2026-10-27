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
import { Refusal } from './refusal.js';

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
  }>(
    `SELECT trial, repeat_months, discount_paise, subtotal_paise, gst_paise, total_paise,
            first_hour_at, ads_due_at, price_book_version
       FROM bookings WHERE booking_id = $1 AND brand_id = $2`,
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
  const agreed = await c.query<{ at: Date }>('SELECT at FROM booking_terms WHERE booking_id = $1', [
    bookingId,
  ]);
  const listPaise = lines.rows.reduce((n, l) => n + Number(l.paise), 0);
  return {
    bookingId,
    state: (await bookingState(c, bookingId)) ?? 'draft',
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
      book.taxes.supplierStateCode,
      tax.rows[0]?.state_code ?? book.taxes.supplierStateCode,
    ),
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
 * The brand agrees to the rules and pays: the agreement is kept (once per booking), then the
 * payment link is made (or the live one given again). Refused when the booking is not this
 * business's, is not waiting to be paid, or can no longer start (the portal's lead days).
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
  const b = await pool.query<{ first_hour_at: Date; channel: string; trial: boolean }>(
    'SELECT first_hour_at, channel, trial FROM bookings WHERE booking_id = $1 AND brand_id = $2',
    [p.bookingId, p.brandId],
  );
  const x = b.rows[0];
  if (!x) throw new Refusal('No such campaign', { code: 'no-booking' });
  if (x.trial) throw new Refusal('A free week needs no payment');
  if (p.termsVersion !== TERMS_VERSION)
    throw new Refusal('The rules have changed: read them again and tick the box', {
      code: 'terms-changed',
    });
  const state = await bookingState(pool, p.bookingId);
  if (state !== 'draft' && state !== 'awaiting-payment')
    throw new Refusal(
      state === 'cancelled'
        ? 'This campaign was cancelled: book again'
        : 'This campaign is paid already',
    );
  // A draft booked on the portal must still start the lead days ahead when it is paid.
  const book = priceBookAt(await priceBooks(pool), isoAt(now));
  if (
    state === 'draft' &&
    x.channel === 'portal' &&
    book &&
    secs(x.first_hour_at) < now + book.portalLeadDays * 86_400
  )
    throw new Refusal(
      `It now starts in less than ${book.portalLeadDays} days: book it again with a later start, or call us`,
      { code: 'too-soon' },
    );
  await pool.query(
    `INSERT INTO booking_terms (booking_id, terms_version, accepted_by, ip, at)
     VALUES ($1, $2, $3, $4, to_timestamp($5)) ON CONFLICT (booking_id) DO NOTHING`,
    [p.bookingId, p.termsVersion, p.by.slice(0, 254), p.ip.slice(0, 64), now],
  );
  try {
    return await sendForPayment(pool, payments, p.bookingId, p.by, now);
  } catch (e) {
    // Hours sold to someone else since it was booked (a draft holds none): told plainly.
    if (e instanceof CapacityError)
      throw new Refusal('Some of these hours were sold meanwhile: book again with other hours', {
        code: 'sold-out',
      });
    if (e instanceof StepRace) throw new Refusal('This campaign just changed: open it again');
    throw e;
  }
}
