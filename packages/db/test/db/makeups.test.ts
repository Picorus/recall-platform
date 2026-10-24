import { generateKeyPairSync, sign } from 'node:crypto';
import {
  launchAreas,
  lineIdOf,
  lineStartsAt,
  makeUpWindows,
  playBytes,
  PRICE_BOOK_V1,
  type Numbered,
  type PlayReport,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { saveAreaVersion } from '../../src/areas.js';
import { createBooking, moveBooking, savePriceBook } from '../../src/bookings.js';
import { decideRefund, makeUpsDue, settleDue } from '../../src/makeups.js';
import { addScreenKey, lineTotalsFor } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const LINE = lineIdOf('BK-M1', 'hyd-madhapur', DATE, 18);
const FULL = lineIdOf('BK-M2', 'hyd-madhapur', DATE, 10);
const TRIAL = lineIdOf('BK-M3', 'hyd-kondapur', DATE, 18);
const HOUR = lineStartsAt({ date: DATE, startHour: 18 });
const W = makeUpWindows({ lineId: LINE, areaId: 'hyd-madhapur', date: DATE, startHour: 18 });
const W1 = W.first ?? W.second;

const keys = new Map<string, ReturnType<typeof generateKeyPairSync>['privateKey']>();
const seqs = new Map<string, number>();
async function screen(id: string) {
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
/** `n` plays from one screen, 15 s apart from `start`, inside Madhapur (or Kondapur). */
function plays(
  id: string,
  n: number,
  start: number,
  over: Partial<Omit<PlayReport, 'sig'>> = {},
): Numbered[] {
  const k = keys.get(id);
  if (!k) throw new Error('no key');
  return Array.from({ length: n }, (_, i) => {
    const seq = (seqs.get(id) ?? 0) + 1;
    seqs.set(id, seq);
    const body: Omit<PlayReport, 'sig'> = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref: LINE,
      adId: 'ad-1',
      startAt: start + i * 15,
      lengthS: 15,
      latE6: 17_448_000,
      lngE6: 78_395_000,
      accuracyM: 8,
      place: 'inside:hyd-madhapur@1',
      people: 0,
      ...over,
    };
    const sig = sign('sha256', Buffer.from(playBytes(id, seq, body)), {
      key: k,
      dsaEncoding: 'der',
    });
    return { seq, at: body.startAt + 15, report: { ...body, sig: sig.toString('base64') } };
  });
}
const upload = (id: string, batch: Numbered[], now: number) => storeUpload(pool, id, batch, 1, now);

async function book(id: string, areaId: string, startHour: number, bikes: number, trial = false) {
  await createBooking(
    pool,
    {
      bookingId: id,
      brandId: `brand-${id}`,
      request: {
        lines: [{ areaId, date: DATE, startHour, bikes }],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'priya',
      ...(trial ? { trialFor: { phone: '9876543210' } } : {}),
    },
    BOOKED,
  );
  // A free trial goes through the same steps (paid at ₹0).
  await moveBooking(pool, id, 'awaiting-payment', { by: 'priya', actor: 'admin' }, BOOKED);
  await moveBooking(pool, id, 'paid', { by: 'gateway', actor: 'system' }, BOOKED + 60);
  await moveBooking(pool, id, 'ads-approved', { by: 'priya', actor: 'admin' }, BOOKED + 120);
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  // A low minimum (a setting) keeps the play counts in this test small.
  await savePriceBook(pool, { ...PRICE_BOOK_V1, minBookingPaise: 100_000 }, 'prateek');
  await book('BK-M1', 'hyd-madhapur', 18, 5); // 1,000 plays, ₹1,500
  await book('BK-M2', 'hyd-madhapur', 10, 5);
  await book('BK-M3', 'hyd-kondapur', 18, 5, true);
  for (const s of ['s1', 's2', 's3', 's4', 'f1', 'f2', 'f3', 'f4', 'f5']) await screen(s);
}, 60_000);
afterAll(async () => db.drop());

describe('make-ups and refunds in the database (P1.6)', () => {
  it('nothing is decided until the hour ends + 10 minutes', async () => {
    // 4 screens × 225 plays = 900 of the 1,000 promised.
    for (const s of ['s1', 's2', 's3', 's4']) await upload(s, plays(s, 225, HOUR), HOUR + 3500);
    // The 10 am line was delivered in full (decided as soon as its hour closed); the trial got nothing.
    const ten = lineStartsAt({ date: DATE, startHour: 10 });
    for (const s of ['f1', 'f2', 'f3', 'f4', 'f5'])
      await upload(s, plays(s, 200, ten, { ref: FULL }), ten + 3500);
    await settleDue(pool, HOUR + 3600 + 599);
    const six = await pool.query(`SELECT 1 FROM line_settlements WHERE line_id = $1`, [LINE]);
    expect(six.rows).toEqual([]);
  }, 60_000);

  it('short by 100 at 7:10 pm: a make-up of 100 plays opens for 7–9 pm in Madhapur', async () => {
    await settleDue(pool, HOUR + 3600 + 600);
    expect(await makeUpsDue(pool, 'hyd-madhapur', DATE, 19)).toEqual([
      { makeUpId: `${LINE}#1`, brandId: 'brand-BK-M1', plays: 100 },
    ]);
    expect(await makeUpsDue(pool, 'hyd-madhapur', DATE, 20)).toHaveLength(1);
    // The full line needs nothing.
    const full = await pool.query(`SELECT outcome FROM line_settlements WHERE line_id = $1`, [
      FULL,
    ]);
    expect(full.rows).toEqual([{ outcome: 'not needed' }]);
  }, 60_000);

  it('make-up plays count inside the window only; what is left shrinks', async () => {
    await upload(
      's1',
      plays('s1', 60, W1.from, { slot: 'make-up', ref: `${LINE}#1` }),
      W1.from + 1000,
    );
    await upload(
      's2',
      plays('s2', 5, W1.until + 60, { slot: 'make-up', ref: `${LINE}#1` }),
      W1.until + 200,
    );
    expect((await lineTotalsFor(pool, `${LINE}#1`)).plays).toBe(60);
    expect(await makeUpsDue(pool, 'hyd-madhapur', DATE, 20)).toEqual([
      { makeUpId: `${LINE}#1`, brandId: 'brand-BK-M1', plays: 40 },
    ]);
  }, 60_000);

  it('late uploads still count: 10 more line plays arrive, so the next-day make-up is 30, not 40', async () => {
    await upload('s3', plays('s3', 10, HOUR + 3400), W1.until);
    await settleDue(pool, W1.until + 600);
    const due = await makeUpsDue(pool, 'hyd-madhapur', '2027-08-25', 18);
    expect(due).toEqual([{ makeUpId: `${LINE}#2`, brandId: 'brand-BK-M1', plays: 30 }]);
  }, 60_000);

  it('still 25 short when the next day closes: a refund of 25/200 × ₹300 = ₹37.50 + GST is proposed', async () => {
    await upload(
      's4',
      plays('s4', 5, W.second.from, { slot: 'make-up', ref: `${LINE}#2` }),
      W.second.from + 900,
    );
    expect(await settleDue(pool, W.second.until + 86_400 - 1)).toBe(0);
    await settleDue(pool, W.second.until + 86_400);
    const r = await pool.query(
      `SELECT missing_plays, paid_paise::int, base_paise::int, gst_paise::int FROM refunds WHERE line_id = $1`,
      [LINE],
    );
    expect(r.rows).toEqual([
      { missing_plays: 25, paid_paise: 150_000, base_paise: 3_750, gst_paise: 675 },
    ]);
  }, 60_000);

  it('a free trial that falls short gets make-ups but no refund (nothing was paid)', async () => {
    const t = await pool.query(
      `SELECT step, outcome FROM line_settlements WHERE line_id = $1 ORDER BY decided_at, step`,
      [TRIAL],
    );
    expect(t.rows.map((x) => `${x.step}:${x.outcome}`)).toEqual([
      'first:make-up',
      'second:make-up',
      'refund:nothing paid',
    ]);
  });

  it('running again, or several at once, decides nothing twice', async () => {
    const later = W.second.until + 3 * 86_400;
    const runs = await Promise.all([
      settleDue(pool, later),
      settleDue(pool, later),
      settleDue(pool, later),
    ]);
    expect(runs).toEqual([0, 0, 0]);
    const n = await pool.query(`SELECT count(*)::int AS n FROM refunds`);
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it('only a super admin decides a refund, and only once', async () => {
    const id = `${LINE}#refund`;
    await expect(
      decideRefund(pool, id, 'approved', { id: 'priya', role: 'admin' }, 'brand asked'),
    ).rejects.toThrow(/super admin/);
    await decideRefund(
      pool,
      id,
      'approved',
      { id: 'prateek', role: 'super-admin' },
      'short by 25 plays',
    );
    await expect(
      decideRefund(pool, id, 'rejected', { id: 'prateek', role: 'super-admin' }, 'changed my mind'),
    ).rejects.toThrow();
  });

  it('decisions cannot be edited or deleted', async () => {
    await expect(pool.query(`UPDATE refunds SET base_paise = 1`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM make_ups`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM line_settlements`)).rejects.toThrow();
  });
});
