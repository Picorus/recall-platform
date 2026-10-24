import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  balances,
  bookingPaid,
  checkEntry,
  earnedPaise,
  lineEarned,
  refundApproved,
  reversal,
  type Account,
  type Entry,
} from '../src/ledger.js';

const T = 1_850_000_000;
const paid = bookingPaid({
  bookingId: 'BK-1',
  brandId: 'brand-1',
  subtotal: 150_000,
  gst: 27_000,
  paymentId: 'pay-1',
  at: T,
});
/** Assets + expenses = liabilities + income, always. */
const equation = (entries: readonly Entry[]) => {
  const b = balances(entries);
  let left = 0;
  let right = 0;
  for (const [a, v] of b) {
    if (ACCOUNTS[a] === 'asset' || ACCOUNTS[a] === 'expense') left += v;
    else right += v;
  }
  return [left, right];
};

describe('entries (P1.7.1)', () => {
  it('a booking paid in advance: the money is held, the GST owed at once', () => {
    expect(checkEntry(paid)).toEqual([]);
    expect(Object.fromEntries(balances([paid]))).toEqual({
      'payment-clearing': 177_000,
      'campaign-held': 150_000,
      'gst-payable': 27_000,
    });
  });

  it('refuses unbalanced, fractional, negative, two-sided or one-posting entries', () => {
    const base = { entryId: 'x', at: T, kind: 'k', ref: 'r', memo: 'm' };
    const p = (account: Account, debit: number, credit: number) => ({ account, debit, credit });
    expect(checkEntry({ ...base, postings: [p('bank', 100, 0), p('revenue', 0, 99)] })).toEqual([
      'not balanced: debits 100, credits 99',
    ]);
    expect(
      checkEntry({ ...base, postings: [p('bank', 10.5, 0), p('revenue', 0, 10.5)] }),
    ).toContain('amounts must be whole paise, not negative');
    expect(checkEntry({ ...base, postings: [p('bank', -5, 0), p('revenue', 0, -5)] })).toContain(
      'amounts must be whole paise, not negative',
    );
    expect(checkEntry({ ...base, postings: [p('bank', 5, 5), p('revenue', 0, 0)] })).toContain(
      'each posting is either a debit or a credit, more than 0',
    );
    expect(checkEntry({ ...base, postings: [p('bank', 0, 0)] })).toContain(
      'an entry needs at least two postings',
    );
    expect(
      checkEntry({ ...base, postings: [p('cash' as Account, 5, 0), p('revenue', 0, 5)] }),
    ).toContain('unknown account cash');
  });

  it('a mistake is undone by a reversing entry, never by editing: the two cancel exactly', () => {
    const r = reversal(paid, T + 60, 'paid twice by mistake');
    expect(checkEntry(r)).toEqual([]);
    expect(r.reverses).toBe(paid.entryId);
    expect([...balances([paid, r]).values()].every((v) => v === 0)).toBe(true);
  });
});

describe('held → earned, hour by hour (P1.7.3)', () => {
  it('the delivered share of what was paid, rounded down; extra plays earn nothing more', () => {
    expect(earnedPaise(150_000, 1000, 900)).toBe(135_000);
    expect(earnedPaise(100, 3, 1)).toBe(33);
    expect(earnedPaise(150_000, 1000, 1500)).toBe(150_000);
    expect(earnedPaise(150_000, 0, 10)).toBe(0);
  });

  it('only the newly earned part moves; nothing new, no entry', () => {
    const e = lineEarned({
      lineId: 'L1',
      brandId: 'brand-1',
      earnedNow: 135_000,
      earnedSoFar: 100_000,
      closeId: '1',
      at: T,
    });
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['campaign-held', 35_000, 0],
      ['revenue', 0, 35_000],
    ]);
    expect(
      lineEarned({ lineId: 'L1', brandId: 'b', earnedNow: 5, earnedSoFar: 5, closeId: '2', at: T }),
    ).toBeUndefined();
  });

  it('a short line: earned + refund = what was paid, and held ends at exactly 0', () => {
    // ₹1,500 paid for 1,000 plays; 975 delivered; 25 refunded (₹37.50 + ₹6.75 GST).
    const earned = lineEarned({
      lineId: 'L1',
      brandId: 'brand-1',
      earnedNow: earnedPaise(150_000, 1000, 975),
      earnedSoFar: 0,
      closeId: '1',
      at: T,
    });
    const refund = refundApproved({
      refundId: 'L1#refund',
      lineId: 'L1',
      brandId: 'brand-1',
      base: 3_750,
      gst: 675,
      at: T + 86_400,
    });
    const all = [paid, ...(earned ? [earned] : []), refund];
    all.forEach((e) => expect(checkEntry(e)).toEqual([]));
    const b = balances(all);
    expect(b.get('campaign-held')).toBe(0);
    expect(b.get('revenue')).toBe(146_250);
    expect(b.get('refunds-payable')).toBe(4_425);
    expect(b.get('gst-payable')).toBe(26_325);
  });

  it('property: hour after hour, the steps add up to the final earned amount, never more than paid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.integer({ min: 0, max: 5_000 }), { maxLength: 30 }),
        (paidPaise, promised, deliveries) => {
          let delivered = 0;
          let soFar = 0;
          deliveries.forEach((d, i) => {
            delivered += d;
            const e = lineEarned({
              lineId: 'L',
              brandId: 'b',
              earnedNow: earnedPaise(paidPaise, promised, delivered),
              earnedSoFar: soFar,
              closeId: String(i),
              at: T,
            });
            if (e) {
              expect(checkEntry(e)).toEqual([]);
              soFar += e.postings[0]?.debit ?? 0;
            }
          });
          expect(soFar).toBe(earnedPaise(paidPaise, promised, delivered));
          expect(soFar).toBeLessThanOrEqual(paidPaise);
        },
      ),
    );
  });
});

describe('the ledger always balances (property)', () => {
  it('any mix of bookings, deliveries, refunds and reversals: every entry balances and assets + expenses = liabilities + income', () => {
    const event = fc.oneof(
      fc.record({
        kind: fc.constant('paid' as const),
        subtotal: fc.integer({ min: 0, max: 50_000_000 }),
        gst: fc.integer({ min: 0, max: 9_000_000 }),
      }),
      fc.record({
        kind: fc.constant('earned' as const),
        more: fc.integer({ min: 0, max: 5_000_000 }),
      }),
      fc.record({
        kind: fc.constant('refund' as const),
        base: fc.integer({ min: 0, max: 5_000_000 }),
        gst: fc.integer({ min: 0, max: 900_000 }),
      }),
      fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 60 }), (events) => {
        const entries: Entry[] = [];
        events.forEach((ev, i) => {
          let e: Entry | undefined;
          if (ev.kind === 'paid' && ev.subtotal + ev.gst > 0)
            e = bookingPaid({
              bookingId: `B${i}`,
              brandId: 'b',
              subtotal: ev.subtotal,
              gst: ev.gst,
              paymentId: 'p',
              at: T + i,
            });
          if (ev.kind === 'earned')
            e = lineEarned({
              lineId: `L${i}`,
              brandId: 'b',
              earnedNow: ev.more,
              earnedSoFar: 0,
              closeId: '1',
              at: T + i,
            });
          if (ev.kind === 'refund' && ev.base + ev.gst > 0)
            e = refundApproved({
              refundId: `R${i}`,
              lineId: `L${i}`,
              brandId: 'b',
              base: ev.base,
              gst: ev.gst,
              at: T + i,
            });
          if (ev.kind === 'reverse' && entries.length > 0) {
            const target = entries[ev.pick % entries.length];
            if (target && !target.reverses) e = reversal(target, T + i, 'test');
          }
          if (e && e.postings.length >= 2) {
            expect(checkEntry(e)).toEqual([]);
            entries.push(e);
          }
        });
        const [left, right] = equation(entries);
        expect(left).toBe(right);
      }),
      { numRuns: 500 },
    );
  });
});
