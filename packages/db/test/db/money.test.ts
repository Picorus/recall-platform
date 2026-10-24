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
import { settleDue } from '../../src/makeups.js';
import { closeEarnings, decideRefund } from '../../src/earnings.js';
import { giveCut } from '../../src/cuts.js';
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

async function book(
  id: string,
  areaId: string,
  startHour: number,
  bikes: number,
  trial = false,
  upTo: 'paid' | 'ads-approved' = 'ads-approved',
) {
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
  if (upTo === 'ads-approved')
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
/** Revenue a booking's plays delivered (money kept without delivery left out). */
const deliveredFor = async (bookingId: string) => {
  const r = await pool.query<{ n: string }>(
    `SELECT coalesce(sum(p.credit - p.debit), 0) AS n
       FROM ledger_postings p JOIN ledger_entries e USING (entry_id)
      WHERE p.account = 'revenue' AND e.kind LIKE 'line-earned%' AND e.ref LIKE $1 || '/%'`,
    [bookingId],
  );
  return Number(r.rows[0]?.n ?? 0);
};
const owedTo = async (account: 'agency-payable' | 'aggregator-payable', partner: string) => {
  const t = await accountTotals(pool, account, { party: partner });
  return t.credit - t.debit;
};
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
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
    expect((await closeEarnings(pool, HOUR + 3600 + 600)).posted).toBe(0);
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
    // Settled in the same step as the decision: held is never below 0, even before the next close.
    expect(await held('brand-BK-M1')).toBe(0);
    expect(await held('brand-BK-M2')).toBe(0);
    await closeEarnings(pool, close + 120);
    expect(await held('brand-BK-M1')).toBe(0);
    expect(await held('brand-BK-M2')).toBe(0);
    expect(await revenueFor(LINE)).toBe(146_250);
    expect(await revenueFor(FULL)).toBe(120_000);
    const owed = await accountTotals(pool, 'refunds-payable');
    expect(owed.credit - owed.debit).toBe(3_750 + 675 + 30_000 + 5_400);
    // Closed lines are not looked at again.
    expect((await closeEarnings(pool, close + 3 * 86_400)).posted).toBe(0);
  });

  it('a close run again at the same moment after plays changed posts the difference, without clashing', async () => {
    await book('BK-Z', 'hyd-madhapur', 20, 5);
    const twenty = lineStartsAt({ date: DATE, startHour: 20 });
    for (const s of ['z1', 'z2']) {
      await screen(s);
      await upload(
        s,
        plays(s, 200, twenty, { ref: lineIdOf('BK-Z', 'hyd-madhapur', DATE, 20) }),
        twenty + 3500,
      );
    }
    const t = twenty + 3600 + 600;
    await closeEarnings(pool, t);
    await revokeScreenKey(pool, 'z2', 'k1', 'prateek', 'stolen, plays faked', twenty);
    const again = await closeEarnings(pool, t);
    expect(again.failed).toEqual([]);
    expect(await revenueFor(lineIdOf('BK-Z', 'hyd-madhapur', DATE, 20))).toBe(30_000);
  }, 60_000);

  it('plays found fake after a refund was proposed: the credit note is topped up at approval', async () => {
    await book('BK-T', 'hyd-madhapur', 19, 5);
    const line = lineIdOf('BK-T', 'hyd-madhapur', DATE, 19);
    const start = lineStartsAt({ date: DATE, startHour: 19 });
    for (const s of ['t1', 't2']) {
      await screen(s);
      await upload(s, plays(s, 200, start, { ref: line }), start + 3500);
    }
    const w = makeUpWindows({ lineId: line, areaId: 'hyd-madhapur', date: DATE, startHour: 19 });
    const close = w.second.until + 86_400;
    for (let i = 0; i < 3; i += 1) await settleDue(pool, close);
    const r = await pool.query(`SELECT base_paise::int AS base FROM refunds WHERE line_id = $1`, [
      line,
    ]);
    expect(r.rows).toEqual([{ base: 90_000 }]); // 600 of 1,000 missing
    await revokeScreenKey(pool, 't2', 'k1', 'prateek', 'stolen, plays faked', start);
    const out = await decideRefund(pool, `${line}#refund`, 'approved', SUPER, 'short', close + 60);
    expect(out).toEqual({});
    // Now 800 missing: ₹1,200 + 18% GST back to the brand; only the 200 delivered plays are earned.
    const owed = await accountTotals(pool, 'refunds-payable', { party: 'brand-BK-T' });
    expect(owed.credit - owed.debit).toBe(120_000 + 21_600);
    expect(await held('brand-BK-T')).toBe(0);
    expect(await deliveredFor('BK-T')).toBe(30_000);
    expect(await revenueFor(line)).toBe(30_000);
    await expect(
      decideRefund(pool, `${line}#refund`, 'rejected', SUPER, 'changed mind', close + 120),
    ).rejects.toThrow(/already approved by prateek/);
  }, 60_000);

  it('ads never came: no refund, everything paid is earned and nothing stays held', async () => {
    await book('BK-X', 'hyd-madhapur', 21, 5, false, 'paid');
    const started = lineStartsAt({ date: DATE, startHour: 21 }) + 60;
    await moveBooking(pool, 'BK-X', 'ads-missing', { by: 'system', actor: 'system' }, started);
    await closeEarnings(pool, started + 60);
    expect(await held('brand-BK-X')).toBe(0);
    expect(await revenueFor(lineIdOf('BK-X', 'hyd-madhapur', DATE, 21))).toBe(150_000);
  });

  it('cancelled more than 72 hours before: a full refund is proposed; nothing is earned until a super admin decides', async () => {
    await book('BK-Y', 'hyd-madhapur', 22, 5, false, 'paid');
    await moveBooking(
      pool,
      'BK-Y',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand changed plans' },
      BOOKED + 3600,
    );
    await settleDue(pool, BOOKED + 7200);
    await closeEarnings(pool, BOOKED + 7200);
    expect(await held('brand-BK-Y')).toBe(150_000);
    const line = lineIdOf('BK-Y', 'hyd-madhapur', DATE, 22);
    await decideRefund(
      pool,
      `${line}#refund`,
      'approved',
      { id: 'prateek', role: 'super-admin' },
      'cancelled early',
      BOOKED + 9000,
    );
    expect(await held('brand-BK-Y')).toBe(0);
    expect(await revenueFor(line)).toBe(0);
  });

  it('cancelled less than 72 hours before the first hour: no refund is possible, the money is earned', async () => {
    await book('BK-W', 'hyd-kondapur', 23, 5, false, 'paid');
    const start = lineStartsAt({ date: DATE, startHour: 23 });
    await moveBooking(
      pool,
      'BK-W',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand pulled out' },
      start - 71 * 3600,
    );
    await settleDue(pool, start - 70 * 3600);
    await closeEarnings(pool, start - 70 * 3600);
    const line = lineIdOf('BK-W', 'hyd-kondapur', DATE, 23);
    const r = await pool.query(`SELECT 1 FROM refunds WHERE line_id = $1`, [line]);
    expect(r.rows).toEqual([]);
    expect(await held('brand-BK-W')).toBe(0);
    expect(await revenueFor(line)).toBe(110_000); // 5 Lite bike-hours at ₹220
  });

  it('cancelled early, but the super admin says no: no refund, the money is earned', async () => {
    await book('BK-V', 'hyd-kondapur', 22, 5, false, 'paid');
    const start = lineStartsAt({ date: DATE, startHour: 22 });
    await moveBooking(
      pool,
      'BK-V',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand pulled out' },
      start - 5 * 86_400,
    );
    await settleDue(pool, start - 5 * 86_400 + 60);
    const line = lineIdOf('BK-V', 'hyd-kondapur', DATE, 22);
    await decideRefund(
      pool,
      `${line}#refund`,
      'rejected',
      { id: 'prateek', role: 'super-admin' },
      'no refund policy',
      start - 4 * 86_400,
    );
    expect(await held('brand-BK-V')).toBe(0);
    expect(await revenueFor(line)).toBe(150_000);
  });

  it("a cut is given only when a super admin decides, once, on what was delivered, with the partner's GST", async () => {
    const cut = { bookingId: 'BK-M2', kind: 'agency' as const, partnerId: 'adfirst', gstBp: 1_800 };
    await expect(giveCut(pool, cut, { id: 'priya', role: 'admin' }, 'agency deal')).rejects.toThrow(
      /super admin/,
    );
    // No cut given yet: nothing owed to anyone.
    expect(await accountTotals(pool, 'agency-payable')).toEqual({ debit: 0, credit: 0 });
    await giveCut(
      pool,
      cut,
      { id: 'prateek', role: 'super-admin' },
      'AdFirst brought this brand',
      W.second.until,
    );
    await expect(
      giveCut(pool, cut, { id: 'prateek', role: 'super-admin' }, 'again', W.second.until),
    ).rejects.toThrow();
    await closeEarnings(pool, W.second.until + 4 * 86_400);
    // BK-M2 delivered ₹1,200 (after the stolen screen's refund): 10% = ₹120, plus 18% GST = ₹21.60,
    // less 2% TDS on the ₹120 (₹2.40), which is owed to the government instead.
    const owed = await accountTotals(pool, 'agency-payable', { party: 'adfirst' });
    expect(owed.credit - owed.debit).toBe(12_000 + 2_160 - 240);
    const tds = await accountTotals(pool, 'tds-payable', { party: 'adfirst' });
    expect(tds.credit - tds.debit).toBe(240);
    const itc = await accountTotals(pool, 'gst-input');
    expect(itc.debit - itc.credit).toBe(2_160);
    // Running again owes nothing more.
    await closeEarnings(pool, W.second.until + 5 * 86_400);
    const again = await accountTotals(pool, 'agency-payable', { party: 'adfirst' });
    expect(again.credit - again.debit).toBe(13_920);
  });

  it('money kept without delivery is booked apart from revenue earned by plays', async () => {
    // BK-W was cancelled too late: ₹1,100 kept, none of it delivered.
    expect(await deliveredFor('BK-W')).toBe(0);
    const kept = await pool.query<{ kind: string }>(
      `SELECT DISTINCT kind FROM ledger_entries WHERE ref = $1 AND kind LIKE 'line-%'`,
      [lineIdOf('BK-W', 'hyd-kondapur', DATE, 23)],
    );
    expect(kept.rows.map((r) => r.kind)).toEqual(['line-kept']);
  });

  it('a cut is never paid on money kept without delivery: a late cancellation, a refund rejected', async () => {
    // Given while the bookings were live, then each was cancelled.
    await book('BK-CA', 'hyd-kondapur', 21, 5, false, 'paid');
    await book('BK-CB', 'hyd-kondapur', 20, 5, false, 'paid');
    for (const id of ['BK-CA', 'BK-CB'])
      await giveCut(
        pool,
        { bookingId: id, kind: 'agency', partnerId: `ag-${id}`, gstBp: 1_800 },
        SUPER,
        'agency brought this brand',
        BOOKED + 600,
      );
    const startA = lineStartsAt({ date: DATE, startHour: 21 });
    const startB = lineStartsAt({ date: DATE, startHour: 20 });
    const cancel = { by: 'priya', actor: 'admin', reason: 'brand pulled out' } as const;
    await moveBooking(pool, 'BK-CA', 'cancelled', cancel, startA - 10 * 3600);
    await moveBooking(pool, 'BK-CB', 'cancelled', cancel, startB - 5 * 86_400);
    await settleDue(pool, startA - 9 * 3600);
    await decideRefund(
      pool,
      `${lineIdOf('BK-CB', 'hyd-kondapur', DATE, 20)}#refund`,
      'rejected',
      SUPER,
      'no refund policy',
      startA - 9 * 3600,
    );
    await closeEarnings(pool, startA - 9 * 3600);
    for (const id of ['BK-CA', 'BK-CB']) {
      expect(await held(`brand-${id}`)).toBe(0);
      expect(await deliveredFor(id)).toBe(0);
      expect(await owedTo('agency-payable', `ag-${id}`)).toBe(0);
    }
  });

  it('a cancellation refund nobody decides in time is taken as rejected, so nothing stays held', async () => {
    await book('BK-CC', 'hyd-kondapur', 19, 5, false, 'paid');
    const start = lineStartsAt({ date: DATE, startHour: 19 });
    const at = start - 5 * 86_400;
    await moveBooking(
      pool,
      'BK-CC',
      'cancelled',
      { by: 'priya', actor: 'admin', reason: 'brand changed plans' },
      at,
    );
    await settleDue(pool, at + 60);
    await closeEarnings(pool, at + 6 * 86_400);
    expect(await held('brand-BK-CC')).toBe(150_000); // within the 7 days: still the super admin's call
    await closeEarnings(pool, at + 7 * 86_400);
    const line = lineIdOf('BK-CC', 'hyd-kondapur', DATE, 19);
    const d = await pool.query(
      'SELECT decision, decided_by FROM refund_decisions WHERE refund_id = $1',
      [`${line}#refund`],
    );
    expect(d.rows).toEqual([{ decision: 'rejected', decided_by: 'system' }]);
    expect(await held('brand-BK-CC')).toBe(0);
    expect(await revenueFor(line)).toBe(150_000);
  });

  it('a cut given long after a booking settled is still paid, at once', async () => {
    const delivered = await deliveredFor('BK-M1');
    expect(delivered).toBeGreaterThan(0);
    await giveCut(
      pool,
      { bookingId: 'BK-M1', kind: 'aggregator', partnerId: 'rapido', gstBp: 0 },
      SUPER,
      'aggregator deal, agreed late',
      W.second.until + 60 * 86_400,
    );
    // 2% of what was delivered, rounded to the paisa; no GST (partner not registered); 2% TDS held back.
    const cut = Math.round(delivered * 0.02);
    expect(await owedTo('aggregator-payable', 'rapido')).toBe(cut - Math.round(cut * 0.02));
  });

  it('a cut can only be given on a paid booking that can still deliver, at a sane rate', async () => {
    const give = (bookingId: string, extra: { rateBp?: number; gstBp?: number } = {}) =>
      giveCut(
        pool,
        { bookingId, kind: 'agency', partnerId: 'adfirst', gstBp: 1_800, ...extra },
        SUPER,
        'agency deal',
        BOOKED + 600,
      );
    await createBooking(
      pool,
      {
        bookingId: 'BK-UNPAID',
        brandId: 'brand-unpaid',
        request: {
          lines: [{ areaId: 'hyd-kondapur', date: DATE, startHour: 13, bikes: 5 }],
          repeatMonths: 1,
          channel: 'admin',
        },
        by: 'priya',
      },
      BOOKED,
    );
    await moveBooking(
      pool,
      'BK-UNPAID',
      'awaiting-payment',
      { by: 'priya', actor: 'admin' },
      BOOKED,
    );
    await expect(give('BK-UNPAID')).rejects.toThrow(/paid booking/);
    await expect(give('BK-M3')).rejects.toThrow(/trial/);
    await expect(give('BK-W')).rejects.toThrow(/cancelled/);
    await expect(give('BK-X')).rejects.toThrow(/ads-missing/);
    await expect(give('BK-M1', { rateBp: 0 })).rejects.toThrow(/rate/);
    await expect(give('BK-M1', { rateBp: 5_001 })).rejects.toThrow(/rate/);
    await expect(give('BK-M1', { gstBp: 3_000 })).rejects.toThrow(/GST/);
    await expect(give('NO-SUCH')).rejects.toThrow(/No booking/);
  });

  it('the whole ledger balances', async () => {
    const t = await trialBalance(pool);
    expect(t.debit).toBe(t.credit);
  });
});
