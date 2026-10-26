// P3.8.2: booking for a brand. Sales, Finance and Support look; a Sales admin makes a booking for a
// brand (any start date, last-minute included: the 15 days are for brands booking in their own
// portal), sends it for payment with a link, checks the payment, cancels it, and adds notes.
//   GET  /bookings/<id>              the booking: lines, money, link, timeline
//   POST /bookings                   { brandId, lines: [{ areaId, date, startHour, bikes }], repeatMonths }
//   POST /bookings/<id>/send         → the payment link (asking again gives the same one)
//   POST /bookings/<id>/check        asks the payment provider now
//   POST /bookings/<id>/cancel       { reason }
//   POST /bookings/<id>/notes        { note }
// And, with no staff sign-in, the payment provider's signed messages:
//   POST /payments/webhook           (header x-payment-signature; trusted only when it checks out)
import type { PaymentsAdapter } from '@recall/adapters';
import {
  BookingError,
  bookingProblemText,
  can,
  type BookingLine,
  type StaffAccess,
} from '@recall/domain';
import {
  addBookingNote,
  bookingView,
  CapacityError,
  cancelBooking,
  checkPayment,
  createBooking,
  findAccount,
  paymentMessage,
  Refusal,
  sendForPayment,
  StepRace,
} from '@recall/db';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { HttpError, jsonBody, send, str } from './http.js';
import { staffFor, type StaffApiConfig } from './staff-api.js';

const mayLook = (a: StaffAccess) =>
  can(a, { area: 'sales', change: false }) ||
  can(a, { area: 'finance', change: false }) ||
  can(a, { area: 'support', change: false });
const sales = { area: 'sales', change: true } as const;
const MAX_LINES = 500;

const newBookingId = () => `BK-${randomBytes(5).toString('hex').toUpperCase()}`;

function refused(e: unknown): never {
  if (e instanceof CapacityError || e instanceof StepRace) throw new HttpError(409, e.message);
  if (e instanceof BookingError)
    throw new HttpError(400, e.problems.map(bookingProblemText).join('; '));
  if (e instanceof Refusal || e instanceof RangeError) throw new HttpError(400, e.message);
  throw e;
}

function readLines(x: unknown): BookingLine[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > MAX_LINES)
    throw new HttpError(400, `Give 1 to ${MAX_LINES} lines`);
  return x.map((l: unknown) => {
    const o = l as Record<string, unknown>;
    if (
      typeof o.areaId !== 'string' ||
      typeof o.date !== 'string' ||
      typeof o.startHour !== 'number' ||
      typeof o.bikes !== 'number'
    )
      throw new HttpError(400, 'Each line needs areaId, date, startHour and bikes');
    return { areaId: o.areaId, date: o.date, startHour: o.startHour, bikes: o.bikes };
  });
}

/** The raw body (the signature covers its exact bytes), up to 16 KB. */
async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new HttpError(413, 'Too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function handleBookings(
  pool: Pool,
  cfg: StaffApiConfig,
  req: IncomingMessage,
  res: ServerResponse,
  nowMs: number,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const now = Math.floor(nowMs / 1000);
  const method = req.method ?? 'GET';
  const payments: PaymentsAdapter | undefined = cfg.payments;

  if (path === '/payments/webhook') {
    if (method !== 'POST') throw new HttpError(405, 'Not allowed');
    if (!payments) throw new HttpError(503, 'Payments are not set up');
    const signature = String(req.headers['x-payment-signature'] ?? '');
    const out = await paymentMessage(pool, payments, await rawBody(req), signature, now);
    if (out === 'forged') throw new HttpError(401, 'Bad signature');
    send(res, 200, { ok: true, outcome: out });
    return true;
  }
  if (path !== '/bookings' && !path.startsWith('/bookings/')) return false;
  if (method === 'POST') {
    const origin = req.headers.origin;
    if (!origin || !cfg.origins.includes(origin))
      throw new HttpError(403, 'Not from the admin site');
  } else if (method !== 'GET') throw new HttpError(405, 'Not allowed');
  const m = /^\/bookings(?:\/(BK-[A-Za-z0-9-]{1,36}))?(?:\/(send|check|cancel|notes))?$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const id = m[1];
  const action = m[2];

  if (method === 'GET') {
    const me = await staffFor(pool, cfg, req, nowMs);
    if (!mayLook(me.access)) throw new HttpError(403, 'Your access does not cover this');
    if (!id || action) throw new HttpError(404, 'Not found');
    const v = await bookingView(pool, id);
    if (!v) throw new HttpError(404, 'No such booking');
    const brand = await findAccount(pool, v.brandId);
    send(res, 200, { at: now, booking: v, brandName: brand?.name ?? v.brandId });
    return true;
  }

  const me = await staffFor(pool, cfg, req, nowMs, sales);
  const who = `${me.name} (${me.id})`.slice(0, 120);
  const b = await jsonBody(req);

  if (!id) {
    if (action) throw new HttpError(404, 'Not found');
    const brandId = str(b, 'brandId', 64);
    const brand = await findAccount(pool, brandId);
    if (!brand || brand.kind !== 'brand')
      throw new HttpError(400, `No brand ${brandId}: open it on the Brands page first`);
    if (!brand.active) throw new HttpError(400, `${brand.name} is closed`);
    const repeatMonths = b.repeatMonths ?? 1;
    if (typeof repeatMonths !== 'number' || !Number.isSafeInteger(repeatMonths) || repeatMonths < 1)
      throw new HttpError(400, 'repeatMonths must be a whole number, 1 or more');
    const bookingId = newBookingId();
    try {
      const q = await createBooking(
        pool,
        {
          bookingId,
          brandId,
          request: { lines: readLines(b.lines), repeatMonths, channel: 'admin' },
          by: who,
        },
        now,
      );
      send(res, 200, {
        bookingId,
        listSubtotal: q.listSubtotal,
        discount: q.discount,
        subtotal: q.subtotal,
        gst: q.gst,
        total: q.total,
        bikeHours: q.bikeHours,
      });
    } catch (e) {
      refused(e);
    }
    return true;
  }

  if (action === 'notes') {
    await addBookingNote(pool, id, str(b, 'note', 2000), who, now).catch(refused);
    send(res, 200, { ok: true });
    return true;
  }
  if (!payments) throw new HttpError(503, 'Payments are not set up');
  if (action === 'send') {
    const link = await sendForPayment(pool, payments, id, who, now).catch(refused);
    send(res, 200, link);
    return true;
  }
  if (action === 'check') {
    send(res, 200, { outcome: await checkPayment(pool, payments, id, now).catch(refused) });
    return true;
  }
  if (action === 'cancel') {
    const reason = str(b, 'reason', 200);
    await cancelBooking(pool, payments, id, who, reason, now).catch(refused);
    send(res, 200, { ok: true });
    return true;
  }
  throw new HttpError(404, 'Not found');
}
