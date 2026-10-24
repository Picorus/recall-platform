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
import { decideRefund, settleDue } from '../../src/makeups.js';
import { closeEarnings } from '../../src/earnings.js';
import { accountTotals, trialBalance } from '../../src/ledger.js';
import { addScreenKey, revokeScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
const LINE = lineIdOf('BK-M1', 'hyd-madhapur', DATE, 18);
const FULL = lineIdOf('BK-M2', 'hyd-madhapur', DATE, 10);
const TEN = lineStartsAt({ date: DATE, startHour: 10 });
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

/** What the brand's money still held for a booking line is (credits less debits). */
const held = async (brand: string) => {
  const t = await accountTotals(pool, 'campaign-held', { party: brand });
  return t.credit - t.debit;
};
const revenueFor = async (ref: string) => {
  const t = await accountTotals(pool, 'revenue', { ref });
  return t.credit - t.debit;
};

describe('money through the ledger (P1.7.2–3)', () => {
  it('paying in advance: ₹1,500 held for the campaign, ₹270 GST owed', async () => {
    expect(await held('brand-BK-M1')).toBe(150_000);
    expect(await accountTotals(pool, 'gst-payable')).toEqual({ debit: 0, credit: 2 * 27_000 });
    // The free trial puts nothing in the ledger.
    expect(await held('brand-BK-M3')).toBe(0);
  });

  it('at each hour close the delivered part moves from held to revenue', async () => {
    for (const s of ['s1', 's2', 's3', 's4']) await upload(s, plays(s, 225, HOUR), HOUR + 3500);
    for (const s of ['f1', 'f2', 'f3', 'f4', 'f5'])
      await upload(s, plays(s, 200, TEN, { ref: FULL }), TEN + 3500);
    await settleDue(pool, HOUR + 3600 + 600);
    await closeEarnings(pool, HOUR + 3600 + 600);
    expect(await revenueFor(LINE)).toBe(135_000); // 900 of 1,000
    expect(await revenueFor(FULL)).toBe(150_000);
    // Running again moves nothing new.
    expect(await closeEarnings(pool, HOUR + 3600 + 600)).toBe(0);
  }, 60_000);

  it('make-up plays earn too', async () => {
    await upload(
      's1',
      plays('s1', 60, W1.from, { slot: 'make-up', ref: `${LINE}#1` }),
      W1.from + 1000,
    );
    await settleDue(pool, W1.until + 600);
    await closeEarnings(pool, W1.until + 600);
    expect(await revenueFor(LINE)).toBe(144_000);
  }, 60_000);

  it('a stolen screen found later: its plays stop counting and their revenue goes back to held', async () => {
    await revokeScreenKey(pool, 'f1', 'k1', 'prateek', 'stolen, plays faked', TEN);
    await closeEarnings(pool, W1.until + 700);
    expect(await revenueFor(FULL)).toBe(120_000);
  });

  it('at day close a refund is proposed; nothing is earned into it while a super admin decides', async () => {
    await upload(
      's4',
      plays('s4', 15, W.second.from, { slot: 'make-up', ref: `${LINE}#2` }),
      W.second.from + 900,
    );
    const close = W.second.until + 86_400;
    await settleDue(pool, close);
    await closeEarnings(pool, close);
    // 975 delivered: 25 missing → ₹37.50 proposed; earned stays at ₹1,462.50.
    expect(await revenueFor(LINE)).toBe(146_250);
    const r = await pool.query(
      `SELECT base_paise::int AS base, gst_paise::int AS gst FROM refunds WHERE line_id = $1`,
      [LINE],
    );
    expect(r.rows).toEqual([{ base: 3_750, gst: 675 }]);
  }, 60_000);

  it('approved: the credit note is owed back to the brand, and the money held for the line ends at exactly ₹0', async () => {
    const close = W.second.until + 86_400;
    await decideRefund(
      pool,
      `${LINE}#refund`,
      'approved',
      { id: 'prateek', role: 'super-admin' },
      'short by 25',
      close + 60,
    );
    await decideRefund(
      pool,
      `${FULL}#refund`,
      'approved',
      { id: 'prateek', role: 'super-admin' },
      'stolen screen',
      close + 60,
    );
    await closeEarnings(pool, close + 120);
    expect(await held('brand-BK-M1')).toBe(0);
    expect(await held('brand-BK-M2')).toBe(0);
    expect(await revenueFor(LINE)).toBe(146_250);
    expect(await revenueFor(FULL)).toBe(120_000);
    const owed = await accountTotals(pool, 'refunds-payable');
    expect(owed.credit - owed.debit).toBe(3_750 + 675 + 30_000 + 5_400);
    // Closed lines are not looked at again.
    expect(await closeEarnings(pool, close + 3 * 86_400)).toBe(0);
  });

  it('the whole ledger balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
