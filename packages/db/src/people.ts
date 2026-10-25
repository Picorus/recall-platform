// P1.8.2–3: people counts tied to booking lines, shown as an approximate range. Each play carries the
// number of people its screen faced while it ran, signed on the screen with the play. A line's
// count is the sum over the plays that count for it (inside its area, edge plays up to their share)
// and over its make-ups' plays. Read only: nothing here is billed or changes money (hard rule 7).
import {
  DEFAULT_PEOPLE_RULES,
  lineIdOf,
  peopleEstimate,
  peopleTotal,
  type PeopleEstimate,
} from '@recall/domain';
import type { Pool } from 'pg';
import { priceBooks } from './bookings.js';
import { countedPlaysFor } from './plays.js';

export interface LinePeople {
  readonly lineId: string;
  readonly areaId: string;
  readonly day: string;
  readonly startHour: number;
  /** Counted plays of the line and its make-ups. */
  readonly plays: number;
  readonly estimate: PeopleEstimate;
}

export interface BookingPeople {
  readonly bookingId: string;
  readonly lines: readonly LinePeople[];
  readonly plays: number;
  /** The whole booking, from the exact total (never the sum of the lines' ranges). */
  readonly estimate: PeopleEstimate;
  /** Plays whose count was above the plausible limit and was taken as the limit: a chip to check. */
  readonly cappedPlays: number;
}

/**
 * People for a booking, by line, as approximate ranges (P1.8.2–3). The exact counts stay inside this
 * function: what it returns is only ever shown as a range. Counts follow the rules of the price book
 * the booking was sold on.
 */
export async function bookingPeople(
  pool: Pick<Pool, 'query'>,
  bookingId: string,
): Promise<BookingPeople | undefined> {
  const b = await pool.query<{ price_book_version: number }>(
    'SELECT price_book_version FROM bookings WHERE booking_id = $1',
    [bookingId],
  );
  const version = b.rows[0]?.price_book_version;
  if (version === undefined) return undefined;
  const books = await priceBooks(pool);
  const rules = books.find((x) => x.version === version)?.people ?? DEFAULT_PEOPLE_RULES;
  const lines = await pool.query<{ area_id: string; day: string; start_hour: number }>(
    `SELECT area_id, day::text AS day, start_hour FROM booking_lines
      WHERE booking_id = $1 ORDER BY day, start_hour, area_id`,
    [bookingId],
  );
  const makeUps = await pool.query<{ make_up_id: string; line_id: string }>(
    'SELECT make_up_id, line_id FROM make_ups WHERE booking_id = $1 ORDER BY make_up_id',
    [bookingId],
  );
  let people = 0;
  let plays = 0;
  let cappedPlays = 0;
  const out: LinePeople[] = [];
  for (const l of lines.rows) {
    const lineId = lineIdOf(bookingId, l.area_id, l.day, l.start_hour);
    const ids = [
      lineId,
      ...makeUps.rows.filter((m) => m.line_id === lineId).map((m) => m.make_up_id),
    ];
    const counted = (await Promise.all(ids.map((id) => countedPlaysFor(pool, id, books)))).flat();
    const t = peopleTotal(counted, rules);
    people += t.people;
    plays += counted.length;
    cappedPlays += t.capped;
    out.push({
      lineId,
      areaId: l.area_id,
      day: l.day,
      startHour: l.start_hour,
      plays: counted.length,
      estimate: peopleEstimate(t.people, rules),
    });
  }
  return { bookingId, lines: out, plays, estimate: peopleEstimate(people, rules), cappedPlays };
}
