// P3.7: the inventory calendar's API. Sales or Operations look (read-only members too); a Sales
// admin holds a client's hours, days and bikes (no money, ends at a set time), releases a hold early
// and turns it into a draft booking; a super admin sets or lifts a manual limit. Each with why.
//   GET  /calendar?area=<id>&from=<YYYY-MM-DD>   one area's week (defaults: first area, today)
//   POST /calendar/limit     { areaId, date, startHour, maxBikes (null lifts it), reason }
//   POST /holds              { brandId, areaId, dates, hours, bikes, until (UTC seconds), reason }
//   POST /holds/<id>/end     { reason }
//   POST /holds/<id>/book    {}  → a draft booking with the hold's lines, for the hold's brand
import {
  BookingError,
  bookingProblemText,
  CALENDAR_HOURS,
  can,
  holdLinesOf,
  hourText,
  isoAt,
  lineStartsAt,
  priceBookAt,
  todayOf,
  type StaffAccess,
} from '@recall/domain';
import {
  allAreaVersions,
  calendarWeek,
  CapacityError,
  createBooking,
  endHold,
  findAccount,
  placeHold,
  priceBooks,
  Refusal,
  setAreaHourLimit,
} from '@recall/db';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) || can(a, { area: 'operations', change: false });
const sales = { area: 'sales', change: true } as const;

/** A short id nobody can guess or mistype into another one: "HLD-7F3K9Q2M". */
const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

function reasonOf(b: Record<string, unknown>): string {
  const r = str(b, 'reason', 200).trim();
  if (r.length < 3) throw new HttpError(400, 'Give a reason (3 to 200 characters)');
  return r;
}

/** The rules' refusals in words (400), a full area-hour as 409; anything else is a fault. */
function refused(e: unknown): never {
  if (e instanceof CapacityError)
    throw new HttpError(
      409,
      `Not enough bikes left: ${e.shortfalls
        .map((s) => {
          const [, date, hour] = s.key.split('|');
          return `${date} ${hourText(Number(hour))} has ${s.free} free`;
        })
        .join('; ')}`,
    );
  if (e instanceof BookingError)
    throw new HttpError(400, e.problems.map(bookingProblemText).join('; '));
  if (e instanceof Refusal || e instanceof RangeError) throw new HttpError(400, e.message);
  const msg = (e as Error).message ?? '';
  if (/^(No hold |This hold )/.test(msg)) throw new HttpError(400, msg);
  if ((e as { code?: string }).code === '23505')
    throw new HttpError(409, 'Someone changed this just now: reload the page and try again');
  throw e;
}

/** Areas that can be sold now (published and on), by name. */
async function sellableAreas(pool: Pool, nowMs: number) {
  const now = new Date(nowMs).toISOString();
  const newest = new Map<string, { areaId: string; name: string; on: boolean }>();
  for (const v of await allAreaVersions(pool)) {
    if (v.draft || v.validFrom > now) continue;
    newest.set(v.areaId, { areaId: v.areaId, name: v.name, on: v.active });
  }
  return [...newest.values()].filter((a) => a.on).sort((a, b) => a.name.localeCompare(b.name));
}

export async function handleCalendar(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const [path = '/', query = ''] = (req.url ?? '/').split('?');
  const ours =
    path === '/calendar' ||
    path.startsWith('/calendar/') ||
    path === '/holds' ||
    path.startsWith('/holds/');
  if (!ours) return false;
  const method = req.method ?? 'GET';
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');
  const now = Math.floor(nowMs / 1000);

  if (method === 'GET' && path === '/calendar') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    const q = new URLSearchParams(query);
    const areas = await sellableAreas(pool, nowMs);
    const areaId = q.get('area') ?? areas[0]?.areaId;
    if (!areaId) {
      send(res, 200, { at: now, areas, week: null });
      return true;
    }
    if (!/^[a-z0-9-]{1,60}$/.test(areaId)) throw new HttpError(400, 'Not an area id');
    const from = q.get('from') ?? todayOf(now);
    let week;
    try {
      week = await calendarWeek(pool, areaId, from, now);
    } catch (e) {
      refused(e);
    }
    send(res, 200, { at: now, areas, week });
    return true;
  }
  if (method !== 'POST') throw new HttpError(404, 'Not found');
  const b = await jsonBody(req);

  if (path === '/calendar/limit') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!can(me.access, { superAdmin: true }))
      throw new HttpError(403, 'Only a super admin sets limits');
    const reason = reasonOf(b);
    const max = b.maxBikes;
    if (
      max !== null &&
      (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0 || max > 100_000)
    )
      throw new HttpError(400, 'The limit is a whole number of bikes (0 to 1,00,000), or none');
    if (typeof b.startHour !== 'number' || !CALENDAR_HOURS.includes(b.startHour))
      throw new HttpError(400, 'startHour must be a start hour (8 to 25)');
    const limitArea = str(b, 'areaId', 60);
    if (!(await allAreaVersions(pool)).some((v) => v.areaId === limitArea))
      throw new HttpError(400, 'No such area');
    const who = `${me.name} (${me.id})`.slice(0, 120);
    await setAreaHourLimit(
      pool,
      { areaId: limitArea, date: str(b, 'date', 10), startHour: b.startHour },
      max,
      who,
      reason,
    ).catch(refused);
    send(res, 200, { ok: true });
    return true;
  }

  const me = await staffFor(pool, cfg, req, nowMs, sales);
  const who = `${me.name} (${me.id})`.slice(0, 120);

  if (path === '/holds') {
    const reason = reasonOf(b);
    const brandId = str(b, 'brandId', 64).replace(/\s/g, '');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(brandId))
      throw new HttpError(400, 'Brand id: lower case letters, digits and dashes');
    // Holds are for a brand account (opened on the Brands page), so a typo cannot block bikes.
    const brand = await findAccount(pool, brandId);
    if (!brand || brand.kind !== 'brand')
      throw new HttpError(400, `No brand ${brandId}: open it on the Brands page first`);
    if (!brand.active) throw new HttpError(400, `${brand.name} is closed`);
    const areaId = str(b, 'areaId', 60);
    if (!(await sellableAreas(pool, nowMs)).some((a) => a.areaId === areaId))
      throw new HttpError(400, 'That area is not on sale');
    if (!Array.isArray(b.dates) || !b.dates.every((d) => typeof d === 'string'))
      throw new HttpError(400, 'dates must be a list of days');
    if (!Array.isArray(b.hours) || !b.hours.every((h) => typeof h === 'number'))
      throw new HttpError(400, 'hours must be a list of start hours');
    if (typeof b.bikes !== 'number' || typeof b.until !== 'number')
      throw new HttpError(400, 'bikes and until must be numbers');
    const until = Math.floor(b.until);
    if (until <= now) throw new HttpError(400, 'A hold must end in the future');
    // How long a hold may last is a setting (price book → capacity.holdMaxDays).
    const book = priceBookAt(await priceBooks(pool), isoAt(now));
    const maxDays = book?.capacity.holdMaxDays ?? 30;
    if (until > now + maxDays * 86_400)
      throw new HttpError(400, `A hold lasts at most ${maxDays} days`);
    const holdId = newId('HLD');
    try {
      const lines = holdLinesOf(areaId, b.dates as string[], b.hours as number[], b.bikes);
      await placeHold(pool, { holdId, brandId, lines, until, by: who, reason }, now);
    } catch (e) {
      refused(e);
    }
    send(res, 200, { holdId });
    return true;
  }

  const m = /^\/holds\/(HLD-[A-Z0-9-]{1,36})\/(end|book)$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const holdId = m[1] ?? '';
  if (m[2] === 'end') {
    await endHold(pool, holdId, who, reasonOf(b), now).catch(refused);
    send(res, 200, { ok: true });
    return true;
  }
  // Turn into a draft booking: the hold's hours still to come, for its brand. The hold keeps the
  // bikes until it ends or is released; the draft itself keeps nothing until it is awaiting payment.
  const h = await pool.query<{
    brand_id: string;
    lines: { areaId: string; date: string; startHour: number; bikes: number }[];
  }>(
    `SELECT h.brand_id,
            (SELECT json_agg(json_build_object('areaId', hl.area_id, 'date', hl.day::text,
                                               'startHour', hl.start_hour, 'bikes', hl.bikes)
                             ORDER BY hl.day, hl.start_hour, hl.area_id)
               FROM hold_lines hl WHERE hl.hold_id = h.hold_id) AS lines
       FROM holds h WHERE h.hold_id = $1`,
    [holdId],
  );
  const hold = h.rows[0];
  if (!hold) throw new HttpError(404, 'No such hold');
  // One booking per hold: a second press must not leave duplicate drafts.
  const made = await pool.query<{ booking_id: string }>(
    `SELECT b.booking_id FROM bookings b
      WHERE b.hold_id = $1
        AND (SELECT state FROM booking_events e WHERE e.booking_id = b.booking_id
              ORDER BY seq DESC LIMIT 1) <> 'cancelled'
      ORDER BY b.created_at LIMIT 1`,
    [holdId],
  );
  if (made.rows[0])
    throw new HttpError(409, `Booking ${made.rows[0].booking_id} was already made from this hold`);
  const ahead = hold.lines.filter((l) => lineStartsAt(l) > now);
  if (ahead.length === 0) throw new HttpError(400, 'Every hour of this hold has already started');
  const bookingId = newId('BK');
  try {
    const quote = await createBooking(
      pool,
      {
        bookingId,
        brandId: hold.brand_id,
        request: { lines: ahead, repeatMonths: 1, channel: 'admin' },
        by: who,
        holdId,
      },
      now,
    );
    send(res, 200, { bookingId, subtotal: quote.subtotal, gst: quote.gst, total: quote.total });
  } catch (e) {
    refused(e);
  }
  return true;
}
