// P5.11: the brand's messages about a campaign: "booked and paid" once (recent payments only), and
// "your ads are due" 9 and then 7 days before the start while no ads are chosen; each once per
// channel, never twice; none once ads are chosen; a passing failure tried again later.
import { fakeMessages } from '@recall/adapters';
import { launchAreas, lineStartsAt, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { sendDueNotices } from '../../src/brand-notices.js';
import { setBrandContact } from '../../src/report-sends.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const FIRST = lineStartsAt({ date: DATE, startHour: 19 });
const PORTAL = 'https://book.recall.test';

async function book(id: string, brand: string) {
  await createBooking(
    pool,
    {
      bookingId: id,
      brandId: brand,
      request: {
        lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour: 19, bikes: 5 }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
    },
    BOOKED,
  );
  await moveBooking(pool, id, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, id, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  await setBrandContact(pool, 'chai', { phone: '+919848011111', email: 'ads@chai.in' }, 'Sana');
  await setBrandContact(pool, 'dosa', { email: 'ads@dosa.in' }, 'Sana');
  await book('BK-N1', 'chai');
  await book('BK-N2', 'dosa');
  // Dosa's ads are chosen: no reminder for it.
  await pool.query(
    `INSERT INTO booking_ad_sets (booking_id, version, ad_ids, set_by, set_at)
     VALUES ('BK-N2', 1, '{AD-0000000001,AD-0000000002}', 'portal', to_timestamp($1))`,
    [BOOKED + 120],
  );
}, 60_000);
afterAll(async () => db.drop());

describe('brand messages (P5.11)', () => {
  it('"booked and paid" once on each channel, with the total and the ads link', async () => {
    const messages = fakeMessages();
    const r = await sendDueNotices(pool, messages, PORTAL, BOOKED + 120);
    expect([...r.sent].sort()).toEqual([
      'BK-N1:paid:email',
      'BK-N1:paid:whatsapp',
      'BK-N2:paid:email',
    ]);
    const mail = messages.sent.find((m) => m.channel === 'email' && m.to === 'ads@chai.in');
    expect(mail?.channel === 'email' && mail.subject).toContain('Booked and paid');
    expect(mail?.channel === 'email' && mail.text).toContain(`${PORTAL}/campaigns?brand=chai`);
    const wa = messages.sent.find((m) => m.channel === 'whatsapp');
    expect(wa?.channel === 'whatsapp' && wa.template).toBe('campaign_booked_paid');
    // Again: nothing new.
    expect((await sendDueNotices(pool, messages, PORTAL, BOOKED + 600)).sent).toEqual([]);
  });

  it('"your ads are due" 9 days before, then 7 days before, only without ads; old payments never', async () => {
    const messages = fakeMessages();
    // Too early: nothing (and the payment is long past: no "booked and paid" for new runs).
    expect((await sendDueNotices(pool, messages, PORTAL, FIRST - 10 * 86_400)).sent).toEqual([]);
    expect(
      [...(await sendDueNotices(pool, messages, PORTAL, FIRST - 8.5 * 86_400)).sent].sort(),
    ).toEqual(['BK-N1:ads-9:email', 'BK-N1:ads-9:whatsapp']);
    expect((await sendDueNotices(pool, messages, PORTAL, FIRST - 8 * 86_400)).sent).toEqual([]);
    expect(
      [...(await sendDueNotices(pool, messages, PORTAL, FIRST - 6 * 86_400)).sent].sort(),
    ).toEqual(['BK-N1:ads-7:email', 'BK-N1:ads-7:whatsapp']);
    const mail = messages.sent.find((m) => m.channel === 'email');
    expect(mail?.channel === 'email' && mail.text).toContain(
      `${PORTAL}/ads?brand=chai&booking=BK-N1`,
    );
    expect((await sendDueNotices(pool, messages, PORTAL, FIRST - 5 * 86_400)).sent).toEqual([]);
  });

  it('a passing failure is tried again 30 minutes later; a wrong address is not', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-N3',
        brandId: 'idli',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: DATE, startHour: 20, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await setBrandContact(pool, 'idli', { phone: '+919848022222', email: 'bad@idli.in' }, 'Sana');
    await moveBooking(pool, 'BK-N3', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    const t = FIRST - 3 * 86_400;
    await moveBooking(pool, 'BK-N3', 'paid', { by: 'gateway', actor: 'system' }, t);
    const down = fakeMessages({
      failFor: new Map([
        ['+919848022222', { reason: 'provider down', retryable: true }],
        ['bad@idli.in', { reason: 'no such mailbox', retryable: false }],
      ]),
    });
    expect((await sendDueNotices(pool, down, PORTAL, t + 60)).sent).toEqual([]);
    const up = fakeMessages();
    expect((await sendDueNotices(pool, up, PORTAL, t + 120)).sent).toEqual([]); // too soon
    // Paid 3 days before the start: "booked and paid" says when ads are due; no reminder too.
    expect((await sendDueNotices(pool, up, PORTAL, t + 60 + 1800)).sent).toEqual([
      'BK-N3:paid:whatsapp',
    ]);
    const kept = await pool.query(
      `SELECT kind, channel, count(*)::int AS n FROM brand_notices WHERE booking_id = 'BK-N3'
        GROUP BY kind, channel ORDER BY kind, channel`,
    );
    expect(kept.rows).toEqual([
      { kind: 'paid', channel: 'email', n: 1 },
      { kind: 'paid', channel: 'whatsapp', n: 2 },
    ]);
  });
});
