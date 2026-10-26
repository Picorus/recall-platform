// P3.8.2: staff booking for a brand: sent for payment with a link, paid through the provider's
// signed message (once), a link running out cancels the booking, late money is recorded, cancel,
// notes and the timeline.
import { fakePayments } from '@recall/adapters';
import { launchAreas, PRICE_BOOK_V1, type BookingLine } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import {
  addBookingNote,
  bookingView,
  cancelBooking,
  checkPayment,
  expireUnpaid,
  paymentMessage,
  sendForPayment,
} from '../../src/booking-desk.js';
import { bookingState, createBooking, savePriceBook } from '../../src/bookings.js';
import { setBrandContact } from '../../src/report-sends.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time
let now = NOW;
const payments = fakePayments({ clock: () => now });
const line = (date: string, startHour: number, bikes = 30): BookingLine => ({
  areaId: 'hyd-madhapur',
  date,
  startHour,
  bikes,
});
const draft = (bookingId: string, lines: BookingLine[]) =>
  createBooking(
    pool,
    {
      bookingId,
      brandId: 'chai-co',
      request: { lines, repeatMonths: 1, channel: 'admin' },
      by: 'Sana',
    },
    now,
  );

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await setBrandContact(pool, 'chai-co', { phone: '+919876543210' }, 'Sana');
});
afterAll(async () => db.drop());

describe('booking for a brand (P3.8.2)', () => {
  it('sent for payment: bikes kept, one link (asking again gives the same), paid once by the signed message', async () => {
    await draft('BK-D-1', [line('2027-08-27', 19), line('2027-08-27', 20)]);
    const a = await sendForPayment(pool, payments, 'BK-D-1', 'Sana', now);
    expect(a).toMatchObject({ amountPaise: 2_124_000, expiresAt: NOW + 24 * 3600 });
    expect(await bookingState(pool, 'BK-D-1')).toBe('awaiting-payment');
    expect(payments.links.get(a.linkId)).toMatchObject({ phone: '+919876543210' });
    expect(await sendForPayment(pool, payments, 'BK-D-1', 'Sana', now + 5)).toEqual(a);
    now += 600;
    const msg = payments.pay(a.linkId);
    expect(await paymentMessage(pool, payments, msg.body, 'f'.repeat(64), now)).toBe('forged');
    expect(await bookingState(pool, 'BK-D-1')).toBe('awaiting-payment');
    expect(await paymentMessage(pool, payments, msg.body, msg.signature, now)).toBe('paid');
    // The same message again (providers resend) changes nothing.
    expect(await paymentMessage(pool, payments, msg.body, msg.signature, now)).toBe('already');
    expect(await bookingState(pool, 'BK-D-1')).toBe('paid');
    const money = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM ledger_entries WHERE entry_id LIKE '%BK-D-1%'",
    );
    expect(Number(money.rows[0]?.n)).toBe(1);
    await expect(sendForPayment(pool, payments, 'BK-D-1', 'Sana', now)).rejects.toThrow(
      'This booking is paid',
    );
  });

  it('a last-minute booking: its link ends at the first hour; unpaid, the booking is cancelled', async () => {
    now = NOW + 3600; // 11:00 India time; the booking starts at 14:00 today
    await draft('BK-D-2', [line('2027-08-23', 14), line('2027-08-23', 15)]);
    const a = await sendForPayment(pool, payments, 'BK-D-2', 'Sana', now);
    expect(a.expiresAt).toBe(Date.UTC(2027, 7, 23, 8, 30) / 1000);
    expect(await expireUnpaid(pool, payments, now + 60)).toEqual([]);
    // A short grace after the end (a payment started in time may still finish).
    now = a.expiresAt + 60;
    expect(await expireUnpaid(pool, payments, now)).toEqual([]);
    now = a.expiresAt + 120;
    expect(await expireUnpaid(pool, payments, now)).toEqual(['BK-D-2']);
    expect(await bookingState(pool, 'BK-D-2')).toBe('cancelled');
    expect(await expireUnpaid(pool, payments, now + 60)).toEqual([]);
  });

  it('money after a cancellation is recorded for finance; staff cancel stops the link', async () => {
    now = NOW + 7200;
    await draft('BK-D-3', [line('2027-08-28', 19), line('2027-08-28', 20)]);
    const a = await sendForPayment(pool, payments, 'BK-D-3', 'Sana', now);
    const msg = payments.pay(a.linkId);
    // Staff cancel before the payment's message arrives: asking the provider finds the money, and
    // it is put on the books as owed back; the message then changes nothing.
    await cancelBooking(pool, payments, 'BK-D-3', 'Sana', 'client changed plans', now + 1);
    expect(await paymentMessage(pool, payments, msg.body, msg.signature, now + 2)).toBe('already');
    const back = await pool.query<{ kind: string }>(
      "SELECT kind FROM ledger_entries WHERE ref = 'BK-D-3'",
    );
    expect(back.rows.map((x) => x.kind)).toEqual(['money-to-return']);
    const v = await bookingView(pool, 'BK-D-3');
    expect(v?.timeline.map((t) => t.text)).toEqual([
      'Draft made',
      'Sent for payment (bikes kept)',
      expect.stringMatching(/^Payment link sent/),
      'Cancelled: client changed plans',
      expect.stringMatching(/^Money received that cannot be kept .*finance to return it$/),
    ]);
    await draft('BK-D-4', [line('2027-08-29', 19), line('2027-08-29', 20)]);
    const b = await sendForPayment(pool, payments, 'BK-D-4', 'Sana', now);
    await cancelBooking(pool, payments, 'BK-D-4', 'Sana', 'duplicate', now + 1);
    expect(await payments.status(b.linkId)).toEqual({ state: 'cancelled' });
    expect(() => payments.pay(b.linkId)).toThrow();
    await expect(cancelBooking(pool, payments, 'BK-D-4', 'Sana', 'again', now + 2)).rejects.toThrow(
      'cannot go from cancelled',
    );
    await expect(cancelBooking(pool, payments, 'BK-D-4', 'Sana', 'x', now + 2)).rejects.toThrow(
      'reason',
    );
  });

  it('checking with the provider; notes; the timeline in order; nothing edited or deleted', async () => {
    await draft('BK-D-5', [line('2027-08-30', 19), line('2027-08-30', 20)]);
    const a = await sendForPayment(pool, payments, 'BK-D-5', 'Sana', now);
    expect(await checkPayment(pool, payments, 'BK-D-5', now + 10)).toBe('waiting');
    now += 15;
    payments.pay(a.linkId); // the provider's message is lost
    expect(await checkPayment(pool, payments, 'BK-D-5', now + 5)).toBe('paid');
    await addBookingNote(pool, 'BK-D-5', 'Brand wants Saturday too', 'Sana', now + 30);
    await expect(addBookingNote(pool, 'BK-NOPE', 'x', 'Sana', now)).rejects.toThrow('No booking');
    const v = await bookingView(pool, 'BK-D-5');
    expect(v).toMatchObject({
      state: 'paid',
      brandId: 'chai-co',
      totalPaise: 2_124_000,
      link: { linkId: a.linkId, states: ['paid'] },
    });
    expect(v?.timeline.map((t) => t.kind)).toEqual([
      'step',
      'step',
      'link',
      'payment',
      'step',
      'note',
    ]);
    expect(await checkPayment(pool, payments, 'BK-NONE', now)).toBe('unknown');
    await expect(pool.query('DELETE FROM payment_links')).rejects.toThrow();
    await expect(pool.query("UPDATE booking_notes SET note = 'x'")).rejects.toThrow();
  });

  it('review P3.8.2: an expiry racing a payment never cancels the paid booking; each payment counted once', async () => {
    for (let i = 0; i < 5; i++) {
      now += 3600;
      const id = `BK-R-${i}`;
      await draft(id, [line('2027-09-06', 19), line('2027-09-06', 20)]);
      const a = await sendForPayment(pool, payments, id, 'Sana', now);
      const msg = payments.pay(a.linkId); // paid in the last moments of the link
      const late = a.expiresAt + 600;
      const [hook] = await Promise.all([
        paymentMessage(pool, payments, msg.body, msg.signature, late),
        expireUnpaid(pool, payments, late),
        checkPayment(pool, payments, id, late),
      ]);
      expect(['paid', 'already']).toContain(hook);
      expect(await bookingState(pool, id)).toBe('paid');
      const kinds = await pool.query<{ kind: string }>(
        'SELECT kind FROM ledger_entries WHERE ref = $1',
        [id],
      );
      expect(kinds.rows.map((x) => x.kind)).toEqual(['booking-paid']);
    }
  });

  it('review P3.8.2: a wrong amount is owed back, not taken as paid; an unknown link is kept for finance', async () => {
    now += 3600;
    await draft('BK-W-1', [line('2027-09-07', 19), line('2027-09-07', 20)]);
    const a = await sendForPayment(pool, payments, 'BK-W-1', 'Sana', now);
    const msg = payments.pay(a.linkId, 100_000);
    expect(await paymentMessage(pool, payments, msg.body, msg.signature, now + 5)).toBe(
      'wrong-amount',
    );
    expect(await paymentMessage(pool, payments, msg.body, msg.signature, now + 6)).toBe('already');
    expect(await bookingState(pool, 'BK-W-1')).toBe('awaiting-payment');
    const e = await pool.query<{ kind: string; memo: string }>(
      "SELECT kind, memo FROM ledger_entries WHERE ref = 'BK-W-1'",
    );
    expect(e.rows).toEqual([
      { kind: 'money-to-return', memo: expect.stringContaining('paid 100000 paise') },
    ]);
    const body = JSON.stringify({
      linkId: 'plink_nobody',
      status: { state: 'paid', paymentId: 'pay_x1', paidAt: now, amountPaise: 5000 },
    });
    expect(await paymentMessage(pool, payments, body, payments.sign(body), now)).toBe('unknown');
    expect(await paymentMessage(pool, payments, body, payments.sign(body), now)).toBe('unknown');
    const inbox = await pool.query('SELECT link_id FROM payment_inbox');
    expect(inbox.rows).toEqual([{ link_id: 'plink_nobody' }]);
  });

  it('review P3.8.2: too late to pay by link; sent with no link made is let go; one bad link never stops the run', async () => {
    now += 3600;
    const start = Math.floor(Date.parse('2027-09-08T13:30:00Z') / 1000); // 19:00 India time
    await draft('BK-L-1', [line('2027-09-08', 19), line('2027-09-08', 20)]);
    await expect(sendForPayment(pool, payments, 'BK-L-1', 'Sana', start - 600)).rejects.toThrow(
      'Too close to the first hour',
    );
    expect(await bookingState(pool, 'BK-L-1')).toBe('draft');
    // A booking sent for payment whose link was never made (the provider did not answer).
    const broken = { ...payments, createLink: () => Promise.reject(new Error('provider down')) };
    await expect(sendForPayment(pool, broken, 'BK-L-1', 'Sana', now)).rejects.toThrow(
      'provider down',
    );
    expect(await bookingState(pool, 'BK-L-1')).toBe('awaiting-payment');
    // A link the provider no longer knows (the fake after a restart) must not stop the others.
    await draft('BK-L-2', [line('2027-09-09', 19), line('2027-09-09', 20)]);
    const b = await sendForPayment(pool, payments, 'BK-L-2', 'Sana', now);
    const forgetful = { ...payments, status: () => Promise.reject(new Error('No link')) };
    const lines: string[] = [];
    const after = b.expiresAt + 600;
    expect(await expireUnpaid(pool, forgetful, after, (l) => lines.push(l))).toEqual(['BK-L-1']);
    expect(lines).toEqual([expect.stringContaining('No link')]);
    expect(await expireUnpaid(pool, payments, after)).toEqual(['BK-L-2']);
  });
});
