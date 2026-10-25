import { fakeMaps, fakeMessages } from '@recall/adapters';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  playBytes,
  PRICE_BOOK_V1,
  refundPaise,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { addScreenKey } from '../../src/plays.js';
import { sendDueReports, setBrandContact } from '../../src/report-sends.js';
import { buildDueReports, campaignReportFor, reportDueAt } from '../../src/reports.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const PLACE = 'inside:hyd-madhapur@1';

const keys = new Map<string, ReturnType<typeof generateKeyPairSync>['privateKey']>();
async function screenKey(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  keys.set(id, privateKey);
  await addScreenKey(
    pool,
    id,
    'k1',
    publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    'fitter',
  );
}
/** `n` signed plays for a line, 15 s apart, inside Madhapur. */
function plays(
  id: string,
  n: number,
  start: number,
  ref: string,
  firstSeq: number,
  people: (i: number) => number,
): Numbered[] {
  const k = keys.get(id);
  if (!k) throw new Error('no key');
  return Array.from({ length: n }, (_, i) => {
    const seq = firstSeq + i;
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref,
      adId: 'ad-1',
      startAt: start + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: PLACE,
      people: people(i),
    };
    const sig = sign('sha256', Buffer.from(playBytes(id, seq, body)), {
      key: k,
      dsaEncoding: 'der',
    });
    return { seq, at: body.startAt + 15, report: { ...body, sig: sig.toString('base64') } };
  });
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
}, 120_000);
afterAll(async () => db.drop());

describe('the final report (P1.9.1)', () => {
  const DAY = '2027-09-30';
  const L10 = lineIdOf('BK-R', 'hyd-madhapur', DAY, 10);
  const L11 = lineIdOf('BK-R', 'hyd-madhapur', DAY, 11);
  const SCREENS = ['scr-1', 'scr-2', 'scr-3', 'scr-4', 'scr-5'];
  const maps = fakeMaps();
  const lastEnds = lineStartsAt({ date: DAY, startHour: 11 }) + 3600;

  it('is built once the last make-up has had time to play, and kept exactly as built', async () => {
    await createBooking(
      pool,
      {
        bookingId: 'BK-R',
        brandId: 'b-r',
        request: {
          lines: [
            { areaId: 'hyd-madhapur', date: DAY, startHour: 10, bikes: 5 },
            { areaId: 'hyd-madhapur', date: DAY, startHour: 11, bikes: 5 },
          ],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(pool, 'BK-R', 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
    await moveBooking(pool, 'BK-R', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    await moveBooking(pool, 'BK-R', 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
    const t10 = lineStartsAt({ date: DAY, startHour: 10 });
    const t11 = t10 + 3600;
    const t11next = lineStartsAt({ date: '2027-10-01', startHour: 11 });
    await pool.query(
      `INSERT INTO make_ups (make_up_id, line_id, booking_id, area_id, stage, day, hours,
        window_from, window_until, plays) VALUES ($1,$2,'BK-R','hyd-madhapur',2,'2027-10-01','{11}',
        to_timestamp($3), to_timestamp($3 + 3600), 400)`,
      [`${L11}#2`, L11, t11next],
    );
    for (const [i, s] of SCREENS.entries()) {
      await screenKey(s);
      // 10:00 in full (5 × 200); 11:00 short (5 × 120 = 600); the make-up brings 100 (5 × 20).
      await storeUpload(
        pool,
        s,
        plays(s, 200, t10, L10, 1, () => 10),
        1,
        t10 + 3500,
      );
      await storeUpload(
        pool,
        s,
        plays(s, 120, t11, L11, 201, () => 10),
        201,
        t11 + 3500,
      );
      await storeUpload(
        pool,
        s,
        plays(s, 20, t11next + i, `${L11}#2`, 321, () => 10),
        321,
        t11next + 3500,
      );
    }

    // Due when the next-day make-up of 11:00 has ended and late uploads came in: 24 h 10 min.
    const due = reportDueAt(
      [
        { areaId: 'hyd-madhapur', date: DAY, startHour: 10 },
        { areaId: 'hyd-madhapur', date: DAY, startHour: 11 },
      ],
      lastEnds,
      PRICE_BOOK_V1,
    );
    expect(due).toBe(lastEnds + 24 * 3600 + 600);
    expect((await buildDueReports(pool, maps, due - 1)).built).toEqual([]);
    expect(await buildDueReports(pool, maps, due)).toEqual({ built: ['BK-R'], failed: [] });
    expect((await buildDueReports(pool, maps, due + 3600)).built).toEqual([]); // once

    const r = await campaignReportFor(pool, 'BK-R');
    expect(r).toMatchObject({
      bookingId: 'BK-R',
      promised: 2_000,
      delivered: 1_700,
      missing: 300,
      deliveredBp: 8_500,
      bikes: 5,
      makeUps: { opened: 1, plays: 100 },
      // 300 missing of 1,000 × ₹1,250 paid for 11:00 (5 bikes × ₹250, Normal band): ₹375, being reviewed
      refund: { paise: refundPaise(300, 1_000, 125_000), status: 'under review' },
      streets: [{ name: 'Madhapur Main Road', plays: 1_700 }],
    });
    expect(r?.refund?.paise).toBe(37_500);
    expect(r?.people.text).toBe('14,000–20,000 people (approximate)'); // 17,000 counted
    expect(r?.heatMap.reduce((n, c) => n + c.plays, 0)).toBe(1_700);
    expect(maps.calls()).toBeLessThanOrEqual(PRICE_BOOK_V1.report.streetCells);

    // The clock moved the booking on to done.
    const s = await pool.query<{ state: string }>(
      `SELECT state FROM booking_events WHERE booking_id = 'BK-R' ORDER BY seq DESC LIMIT 1`,
    );
    expect(s.rows[0]?.state).toBe('done');
    await expect(
      pool.query(`UPDATE campaign_reports SET report = '{}' WHERE booking_id = 'BK-R'`),
    ).rejects.toThrow();
  });

  it('is sent once on WhatsApp and email; a passing failure is tried again; then the booking is report-sent', async () => {
    const now = lastEnds + 26 * 3600;
    const failFor = new Map([
      ['brand@example.in', { reason: 'mail server down', retryable: true }],
    ]);
    const messages = fakeMessages({ failFor });
    const render = {
      link: (id: string) => `https://brand.recall.example/campaigns/${id}/report`,
      html: () => '<p>report</p>',
      pdf: () => Promise.resolve(new Uint8Array([37, 80, 68, 70])),
    };
    expect(await sendDueReports(pool, messages, render, now)).toEqual({
      sent: [],
      noContact: ['BK-R'],
      undelivered: [],
    });
    await expect(setBrandContact(pool, 'b-r', { phone: '98480 22338' }, 'priya')).rejects.toThrow(
      'phone',
    );
    await setBrandContact(
      pool,
      'b-r',
      { phone: '+919848022338', email: 'brand@example.in' },
      'priya',
    );
    // WhatsApp goes; email fails for now: the booking waits.
    expect((await sendDueReports(pool, messages, render, now + 60)).sent).toEqual([]);
    failFor.clear();
    expect((await sendDueReports(pool, messages, render, now + 120)).sent).toEqual(['BK-R']);
    expect((await sendDueReports(pool, messages, render, now + 180)).sent).toEqual([]);
    expect(messages.sent.map((m) => m.channel)).toEqual(['whatsapp', 'email']); // each once
    const [wa, mail] = messages.sent;
    expect(wa?.channel === 'whatsapp' && wa.params).toEqual([
      'BK-R',
      '30 Sep 2027',
      '1,700 of 2,000 plays delivered (85%) on 5 different bikes.',
      'https://brand.recall.example/campaigns/BK-R/report',
    ]);
    expect(mail?.channel === 'email' && mail.attachments[0]?.name).toBe('RECALL-report-BK-R.pdf');
    const tries = await pool.query<{ channel: string; try: number; status: string }>(
      `SELECT channel, try, status FROM report_sends WHERE booking_id = 'BK-R' ORDER BY channel, try`,
    );
    expect(tries.rows).toEqual([
      { channel: 'email', try: 1, status: 'failed' },
      { channel: 'email', try: 2, status: 'sent' },
      { channel: 'whatsapp', try: 1, status: 'sent' },
    ]);
    const s = await pool.query<{ state: string }>(
      `SELECT state FROM booking_events WHERE booking_id = 'BK-R' ORDER BY seq DESC LIMIT 1`,
    );
    expect(s.rows[0]?.state).toBe('report-sent');
  });
});
