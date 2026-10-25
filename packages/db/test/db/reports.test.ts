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
import { settleDue } from '../../src/makeups.js';
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
    for (const s of SCREENS) {
      await screenKey(s);
      // 10:00 in full (5 × 200); 11:00 short (5 × 120 = 600).
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
    }
    // The make-up job: 11:00 owes 400; nothing comes in the next two hours; then the same hour
    // next day, where the make-up brings 100 (5 × 20).
    await settleDue(pool, t11 + 3600 + 600);
    await settleDue(pool, t11 + 3 * 3600 + 600);
    for (const [i, s] of SCREENS.entries())
      await storeUpload(
        pool,
        s,
        plays(s, 20, t11next + i, `${L11}#2`, 321, () => 10),
        321,
        t11next + 3500,
      );

    // Due when the day of the next-day make-up of 11:00 has closed (found in review: the refund is
    // proposed then, and late uploads still count until then): 48 hours.
    const due = reportDueAt(
      [
        { areaId: 'hyd-madhapur', date: DAY, startHour: 10 },
        { areaId: 'hyd-madhapur', date: DAY, startHour: 11 },
      ],
      lastEnds,
      PRICE_BOOK_V1,
    );
    expect(due).toBe(lastEnds + 48 * 3600);
    expect((await buildDueReports(pool, maps, due - 1)).built).toEqual([]);
    // Not before every line has had its last check (the make-up job may run late).
    expect((await buildDueReports(pool, maps, due)).built).toEqual([]);
    expect((await settleDue(pool, due)).failed).toEqual([]);
    // A maps outage: the report still goes out, without street names.
    const down = { streetAt: () => Promise.reject(new Error('maps down')) };
    expect(await buildDueReports(pool, down, due)).toEqual({ built: ['BK-R'], failed: [] });
    expect((await buildDueReports(pool, maps, due + 3600)).built).toEqual([]); // once

    const r = await campaignReportFor(pool, 'BK-R');
    expect(r).toMatchObject({
      bookingId: 'BK-R',
      promised: 2_000,
      delivered: 1_700,
      missing: 300,
      deliveredBp: 8_500,
      bikes: 5,
      makeUps: { opened: 2, plays: 100 },
      // 300 missing of 1,000 × ₹1,250 paid for 11:00 (5 bikes × ₹250, Normal band): ₹375, being reviewed
      refund: { paise: refundPaise(300, 1_000, 125_000), status: 'under review' },
      streets: [],
    });
    expect(r?.refund?.paise).toBe(37_500);
    expect(r?.people.text).toBe('14,000–20,000 people (approximate)'); // 17,000 counted
    expect(r?.heatMap.reduce((n, c) => n + c.plays, 0)).toBe(1_700);

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
    const now = lastEnds + 50 * 3600;
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
    // Found in review: not tried again at once, so a short outage does not use up the tries.
    expect((await sendDueReports(pool, messages, render, now + 120)).sent).toEqual([]);
    expect((await sendDueReports(pool, messages, render, now + 60 + 1800)).sent).toEqual(['BK-R']);
    expect((await sendDueReports(pool, messages, render, now + 4000)).sent).toEqual([]);
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

  it('found in review: a wrong address is given up, and a new address set by staff is tried afresh', async () => {
    const day = '2027-10-20';
    await createBooking(
      pool,
      {
        bookingId: 'BK-T',
        brandId: 'b-t',
        request: {
          lines: [{ areaId: 'hyd-madhapur', date: day, startHour: 10, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    const ends = lineStartsAt({ date: day, startHour: 10 }) + 3600;
    const who = { by: 'priya', actor: 'admin' } as const;
    await moveBooking(pool, 'BK-T', 'awaiting-payment', who, BOOKED);
    await moveBooking(pool, 'BK-T', 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
    await moveBooking(pool, 'BK-T', 'ads-approved', who, BOOKED + 120);
    await moveBooking(pool, 'BK-T', 'running', { by: 'system', actor: 'system' }, ends - 3600);
    await moveBooking(pool, 'BK-T', 'done', { by: 'system', actor: 'system' }, ends);
    const r = await campaignReportFor(pool, 'BK-R');
    await pool.query(
      `INSERT INTO campaign_reports (booking_id, built_at, report) VALUES ('BK-T', to_timestamp($1), $2)`,
      [ends + 48 * 3600, JSON.stringify({ ...r, bookingId: 'BK-T', brandId: 'b-t' })],
    );
    await setBrandContact(pool, 'b-t', { email: 'wrong@example.in' }, 'priya');
    const messages = fakeMessages({
      failFor: new Map([['wrong@example.in', { reason: 'no such mailbox', retryable: false }]]),
    });
    const render = {
      link: (id: string) => `https://brand.recall.example/campaigns/${id}/report`,
      html: () => '<p>report</p>',
      pdf: () => Promise.resolve(new Uint8Array([37, 80, 68, 70])),
    };
    const t = ends + 49 * 3600;
    expect((await sendDueReports(pool, messages, render, t)).undelivered).toEqual(['BK-T']);
    expect((await sendDueReports(pool, messages, render, t + 7200)).undelivered).toEqual(['BK-T']);
    expect(messages.sent).toEqual([]);
    await setBrandContact(pool, 'b-t', { email: 'right@example.in' }, 'priya');
    expect((await sendDueReports(pool, messages, render, t + 7300)).sent).toEqual(['BK-T']);
    expect(messages.sent.map((m) => [m.to, m.key])).toEqual([
      ['right@example.in', 'report:BK-T:email:right@example.in'],
    ]);
  });
});
