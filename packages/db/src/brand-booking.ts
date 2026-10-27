// P5.4 in the database: booking on the brand portal. The form (RECALL's areas with their shapes,
// the hours with their price bands, the ready-made picks, the limits, the earliest start), a live
// price for a plan (bike-hours, plays promised, price, deal discount, GST, total, and anything
// stopping it: under the minimum, too soon, hours already sold), and saving the plan as the
// business's booking (a draft until it is paid: it holds no bikes, P5.6). "Book again" turns an
// earlier booking back into a plan.
import {
  BookingError,
  DEFAULT_BRAND_SIGN_IN,
  HOUR_PICKS,
  PORTAL_HOURS,
  bandOf,
  bikeHourPaise,
  bookingProblemText,
  capacityProblems,
  centreOf,
  earliestStart,
  hourLabel,
  isoAt,
  planLines,
  planProblems,
  priceBookAt,
  publishedAt,
  quote,
  rupeeText,
  type BookingLine,
  type BookingProblem,
  type BrandSignInRules,
  type PortalPlan,
  type PriceBook,
} from '@recall/domain';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { allAreaVersions } from './areas.js';
import { CapacityError, createBooking, inventoryFor, priceBooks } from './bookings.js';
import { inTransaction } from './makeups.js';
import { Refusal } from './refusal.js';

type Q = Pick<Pool, 'query'>;

/** A plan may make at most this many booking lines (a typing slip, not a campaign). */
export const MAX_PORTAL_LINES = 5_000;

export interface BookForm {
  readonly areas: readonly {
    readonly areaId: string;
    readonly name: string;
    /** Its shape: [lng, lat] corners. */
    readonly ring: readonly (readonly [number, number])[];
    readonly centre: readonly [number, number];
  }[];
  readonly hours: readonly {
    readonly hour: number;
    readonly label: string;
    readonly band: string;
    readonly paisePerBikeHour: number;
  }[];
  readonly picks: readonly { key: string; label: string; hours: readonly number[] }[];
  readonly earliestStart: string;
  readonly minBikes: number;
  readonly maxBikes: number;
  readonly maxWeeks: number;
  /** Months → discount in basis points (6: 800 = 8% off). */
  readonly repeatOffersBp: Readonly<Record<number, number>>;
  readonly repeatOfferBands: readonly string[];
  readonly minBookingPaise: number;
  readonly gstBp: number;
  readonly playsPerBikeHour: number;
  readonly adsDueDays: number;
}

async function bookNow(c: Q, now: number): Promise<PriceBook> {
  const book = priceBookAt(await priceBooks(c), isoAt(now));
  if (!book) throw new Refusal('Booking is not open yet: call us', { code: 'no-price-book' });
  return book;
}

/** The areas a brand can pick: on and published at the earliest start. */
async function sellableAreas(c: Q, from: string) {
  const all = await allAreaVersions(c);
  const ids = [...new Set(all.map((a) => a.areaId))];
  return ids
    .flatMap((id) => {
      const a = publishedAt(
        all.filter((x) => x.areaId === id),
        `${from}T00:00:00.000Z`,
      );
      return a?.active ? [a] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function bookForm(
  c: Q,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<BookForm> {
  const book = await bookNow(c, now);
  const from = earliestStart(now, book);
  return {
    areas: (await sellableAreas(c, from)).map((a) => {
      const centre = centreOf(a);
      return {
        areaId: a.areaId,
        name: a.name,
        ring: a.ring.map((p) => [p.lng, p.lat] as const),
        centre: [centre.lng, centre.lat] as const,
      };
    }),
    hours: PORTAL_HOURS.map((hour) => ({
      hour,
      label: hourLabel(hour),
      band: bandOf(book, hour).name,
      paisePerBikeHour: bikeHourPaise(book, hour),
    })),
    picks: HOUR_PICKS.map((p) => ({ key: p.key, label: p.label, hours: p.hours })),
    earliestStart: from,
    minBikes: book.minBikesPerLine,
    maxBikes: rules.maxBikesPerHour,
    maxWeeks: rules.maxWeeks,
    repeatOffersBp: book.repeatOffersBp,
    repeatOfferBands: book.repeatOfferBands,
    minBookingPaise: book.minBookingPaise,
    gstBp: book.gstBp,
    playsPerBikeHour: book.playsPerBikeHour,
    adsDueDays: book.adsDueDays,
  };
}

export interface PortalQuote {
  /** Null when the plan cannot be priced at all (see problems). */
  readonly price: {
    readonly lines: number;
    readonly days: number;
    readonly bikeHours: number;
    readonly plays: number;
    readonly listPaise: number;
    readonly discountPaise: number;
    readonly subtotalPaise: number;
    readonly gstPaise: number;
    readonly totalPaise: number;
    readonly firstDay: string;
    readonly lastDay: string;
  } | null;
  /** Why it cannot be booked as it is, in words for the brand (empty: it can). */
  readonly problems: readonly string[];
}

const DAY_WORDS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_WORDS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
const dayWords = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  return `${DAY_WORDS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTH_WORDS[x.getUTCMonth()]}`;
};

/** A booking problem in the brand's words (line numbers mean nothing to them). */
function brandWords(p: BookingProblem, from: string): string {
  switch (p.kind) {
    case 'below-minimum':
      return `The smallest booking is ${rupeeText(p.minimumPaise)} before GST: add hours, days or bikes`;
    case 'too-soon':
      return `Campaigns booked here start on or after ${dayWords(from)}; sooner only through our team`;
    case 'in-the-past':
      return 'Pick a start date in the future';
    case 'area':
      return 'One of the areas cannot be booked for these days: pick another';
    case 'repeat-not-spread':
      return 'A monthly repeat must play the same days each month';
    default:
      return bookingProblemText(p);
  }
}

/** The words for hours already sold: "Madhapur, Fri 10 Sep, 7 pm: 12 bikes left". */
async function shortWords(
  c: Q,
  lines: readonly BookingLine[],
  now: number,
  inv: Awaited<ReturnType<typeof inventoryFor>>,
) {
  const names = new Map((await allAreaVersions(c)).map((a) => [a.areaId, a.name]));
  return capacityProblems(lines, inv, now)
    .slice(0, 5)
    .map((s) => {
      const [areaId, day, hour] = s.key.split('|');
      return `${names.get(areaId ?? '') ?? areaId}, ${dayWords(day ?? '')}, ${hourLabel(Number(hour))}: ${
        s.free === 0 ? 'sold out' : `${s.free} bikes left`
      }`;
    });
}

/** Prices a plan for the live summary. Never saves anything. */
export async function portalQuote(
  pool: Pool,
  plan: PortalPlan,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<PortalQuote> {
  const book = await bookNow(pool, now);
  const first = planProblems(plan, book, rules);
  if (first.length > 0) return { price: null, problems: first };
  const lines = planLines(plan);
  if (lines.length === 0)
    return { price: null, problems: ['None of those days fall in those weeks'] };
  if (lines.length > MAX_PORTAL_LINES)
    return {
      price: null,
      problems: ['Too many hours for one booking: book it in parts, or call us'],
    };
  const areas = await allAreaVersions(pool);
  const req = { lines, repeatMonths: plan.repeatMonths, channel: 'portal' as const };
  // The numbers even when under the minimum or too soon (the brand sees what to change).
  let q;
  try {
    q = quote(req, { ...book, minBookingPaise: 0 }, areas, now);
  } catch (e) {
    if (!(e instanceof BookingError)) throw e;
    try {
      q = quote({ ...req, channel: 'admin' }, { ...book, minBookingPaise: 0 }, areas, now);
    } catch {
      return {
        price: null,
        problems: [...new Set(e.problems.map((x) => brandWords(x, earliestStart(now, book))))],
      };
    }
  }
  const problems: string[] = [];
  try {
    quote(req, book, areas, now);
  } catch (e) {
    if (!(e instanceof BookingError)) throw e;
    problems.push(...new Set(e.problems.map((x) => brandWords(x, earliestStart(now, book)))));
  }
  const c = await pool.connect();
  try {
    problems.push(...(await shortWords(c, lines, now, await inventoryFor(c, lines, now))));
  } finally {
    c.release();
  }
  const dates = lines.map((l) => l.date).sort();
  return {
    price: {
      lines: lines.length,
      days: new Set(dates).size,
      bikeHours: q.bikeHours,
      plays: q.plays,
      listPaise: q.listSubtotal,
      discountPaise: q.discount,
      subtotalPaise: q.subtotal,
      gstPaise: q.gst,
      totalPaise: q.total,
      firstDay: dates[0] ?? '',
      lastDay: dates.at(-1) ?? '',
    },
    problems,
  };
}

/**
 * Saves a plan as the business's booking (a draft: it holds no bikes until it is paid, P5.6).
 * Refused, in the brand's words, when it cannot be booked.
 */
export async function bookFromPortal(
  pool: Pool,
  b: { readonly brandId: string; readonly plan: PortalPlan; readonly by: string },
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<string> {
  const book = await bookNow(pool, now);
  const problems = planProblems(b.plan, book, rules);
  if (problems.length > 0) throw new Refusal(problems.join('. '));
  // Counted by the database's own clock (the time a booking was written).
  const made = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM bookings
      WHERE created_by = $1 AND created_at > now() - interval '1 day'`,
    [b.by],
  );
  if (Number(made.rows[0]?.n ?? 0) >= rules.bookingsPerDay)
    throw new Refusal('Too many bookings today: try again tomorrow, or call us', {
      code: 'too-many-bookings',
    });
  const lines = planLines(b.plan);
  if (lines.length === 0 || lines.length > MAX_PORTAL_LINES)
    throw new Refusal('Pick days that fall in those weeks, or book in parts');
  const bookingId = `BK-${randomBytes(5).toString('hex').toUpperCase()}`;
  try {
    await createBooking(
      pool,
      {
        bookingId,
        brandId: b.brandId,
        request: { lines, repeatMonths: b.plan.repeatMonths, channel: 'portal' },
        by: b.by,
      },
      now,
    );
  } catch (e) {
    if (e instanceof BookingError)
      throw new Refusal(
        [...new Set(e.problems.map((x) => brandWords(x, earliestStart(now, book))))].join('. '),
      );
    if (e instanceof CapacityError)
      throw new Refusal(
        `Some of these hours are sold: ${(await shortWords(pool, lines, now, await inTransaction(pool, (c) => inventoryFor(c, lines, now)))).join('; ')}`,
        { code: 'sold-out' },
      );
    throw e;
  }
  return bookingId;
}

/** "Book again": an earlier booking of this business as a plan (from the earliest start). */
export async function planFrom(
  c: Q,
  brandId: string,
  bookingId: string,
  now: number,
  rules: BrandSignInRules = DEFAULT_BRAND_SIGN_IN,
): Promise<PortalPlan | undefined> {
  const r = await c.query<{
    area_id: string;
    day: string;
    start_hour: number;
    bikes: number;
    repeat_months: number;
  }>(
    `SELECT bl.area_id, bl.day::text, bl.start_hour, bl.bikes, b.repeat_months
       FROM bookings b JOIN booking_lines bl USING (booking_id)
      WHERE b.booking_id = $1 AND b.brand_id = $2`,
    [bookingId, brandId],
  );
  if (r.rows.length === 0) return undefined;
  const book = await bookNow(c, now);
  const days = [...new Set(r.rows.map((x) => x.day))].sort();
  const repeat = r.rows[0]?.repeat_months ?? 1;
  const day0 = Date.parse(`${days[0]}T00:00:00Z`);
  // A repeat's weeks are its first month's (up to 4); a one-off's, its whole span.
  const own = days.filter(
    (d) => repeat === 1 || Date.parse(`${d}T00:00:00Z`) - day0 < 28 * 86_400_000,
  );
  const span = (Date.parse(`${own.at(-1) ?? days[0]}T00:00:00Z`) - day0) / 86_400_000 + 1;
  return {
    areaIds: [...new Set(r.rows.map((x) => x.area_id))].sort(),
    hours: [...new Set(r.rows.map((x) => x.start_hour))].sort((a, b) => a - b),
    weekdays: [...new Set(days.map((d) => new Date(`${d}T00:00:00Z`).getUTCDay() || 7))].sort(),
    startDate: earliestStart(now, book),
    weeks: Math.max(1, Math.min(repeat > 1 ? 4 : rules.maxWeeks, Math.ceil(span / 7))),
    bikes: Math.max(...r.rows.map((x) => x.bikes)),
    repeatMonths: repeat,
  };
}
