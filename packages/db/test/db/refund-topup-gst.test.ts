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
import { decideRefund } from '../../src/earnings.js';
import { accountTotals } from '../../src/ledger.js';
import { addScreenKey, revokeScreenKey } from '../../src/plays.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const BOOKED = Date.UTC(2027, 6, 1, 4, 30) / 1000;
const DATE = '2027-08-24';
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
      ref: '',
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
  await savePriceBook(
    pool,
    {
      ...PRICE_BOOK_V1,
      minBookingPaise: 100_000,
      bands: PRICE_BOOK_V1.bands.map((b) =>
        b.name === 'Peak' ? { ...b, paisePerBikeHour: 30_006 } : b,
      ),
    },
    'prateek',
  );
}, 60_000);
afterAll(async () => db.drop());

/** What the brand's money still held for a booking line is (credits less debits). */
const held = async (brand: string) => {
  const t = await accountTotals(pool, 'campaign-held', { party: brand });
  return t.credit - t.debit;
};
const SUPER = { id: 'prateek', role: 'super-admin' } as const;
// Found in review (P1.7.4): a price that rounds GST up on each piece could give back 1 paisa more
// GST than the booking was charged once a refund was topped up.
describe('a refund topped up at approval', () => {
  it('never gives back more than the brand paid, nor more GST than was charged', async () => {
    await book('BK-G', 'hyd-madhapur', 19, 5);
    const line = lineIdOf('BK-G', 'hyd-madhapur', DATE, 19);
    const start = lineStartsAt({ date: DATE, startHour: 19 });
    const n = [
      ['g1', 200],
      ['g2', 200],
      ['g3', 100],
    ] as const; // 500 of 1,000 plays
    for (const [s, k] of n) {
      await screen(s);
      await upload(s, plays(s, k, start, { ref: line }), start + 3500);
    }
    const w = makeUpWindows({ lineId: line, areaId: 'hyd-madhapur', date: DATE, startHour: 19 });
    const close = w.second.until + 86_400;
    for (let i = 0; i < 3; i += 1) await settleDue(pool, close);
    for (const [s] of n) await revokeScreenKey(pool, s, 'k1', 'prateek', 'stolen', start);
    await decideRefund(pool, `${line}#refund`, 'approved', SUPER, 'short', close + 60);
    const owed = await accountTotals(pool, 'refunds-payable', { party: 'brand-BK-G' });
    const gstp = await accountTotals(pool, 'gst-payable');
    const pay = await accountTotals(pool, 'payment-clearing', { party: 'brand-BK-G' });
    expect(await held('brand-BK-G')).toBe(0);
    expect(owed.credit - owed.debit).toBeLessThanOrEqual(pay.debit - pay.credit);
    expect(gstp.credit - gstp.debit).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
