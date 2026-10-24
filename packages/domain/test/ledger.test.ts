import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  balances,
  bookingPaid,
  cutAccrued,
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

  it('money kept without delivery is its own kind and id, so cuts can leave it out', () => {
    const e = lineEarned({
      lineId: 'L1',
      brandId: 'brand-1',
      earnedNow: 110_000,
      earnedSoFar: 0,
      closeId: '1',
      at: T,
      part: 'kept',
    });
    expect([e?.entryId, e?.kind]).toEqual(['kept:L1:1', 'line-kept']);
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['campaign-held', 110_000, 0],
      ['revenue', 0, 110_000],
    ]);
  });

  it('plays later found not to count (a stolen screen): the excess goes back from revenue to held', () => {
    const e = lineEarned({
      lineId: 'L1',
      brandId: 'b',
      earnedNow: 120_000,
      earnedSoFar: 150_000,
      closeId: '9',
      at: T,
    });
    expect(checkEntry(e as Entry)).toEqual([]);
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['revenue', 30_000, 0],
      ['campaign-held', 0, 30_000],
    ]);
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
              soFar +=
                e.kind === 'line-earned'
                  ? (e.postings[0]?.debit ?? 0)
                  : -(e.postings[0]?.debit ?? 0);
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

describe("cuts, only when given, the partner's GST included, less TDS (P1.7.4)", () => {
  const cut = {
    bookingId: 'BK-1',
    kind: 'agency' as const,
    partnerId: 'adfirst',
    rateBp: 1000,
    gstBp: 1800,
    tdsBp: 0,
  };

  it("10% of what was delivered, the agency's 18% GST included, owed to the agency; the GST is claimed back", () => {
    const e = cutAccrued(cut, 150_000, { cut: 0, gst: 0, tds: 0 }, 1, T);
    expect(checkEntry(e as Entry)).toEqual([]);
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['agency-cuts', 12_712, 0],
      ['gst-input', 2_288, 0],
      ['agency-payable', 0, 15_000],
    ]);
  });

  it('when earned goes down (plays found fake), the cut and its GST come down too; unchanged, no entry', () => {
    const e = cutAccrued(cut, 120_000, { cut: 12_712, gst: 2_288, tds: 0 }, 2, T);
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['agency-cuts', 0, 2_543],
      ['gst-input', 0, 457],
      ['agency-payable', 3_000, 0],
    ]);
    expect(cutAccrued(cut, 120_000, { cut: 10_169, gst: 1_831, tds: 0 }, 3, T)).toBeUndefined();
  });

  it('₹150 cut with GST included: TDS on the ₹127.12 before GST is held back; the agency gets ₹147.46', () => {
    const e = cutAccrued({ ...cut, tdsBp: 200 }, 150_000, { cut: 0, gst: 0, tds: 0 }, 1, T);
    expect(checkEntry(e as Entry)).toEqual([]);
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['agency-cuts', 12_712, 0],
      ['gst-input', 2_288, 0],
      ['agency-payable', 0, 14_746],
      ['tds-payable', 0, 254],
    ]);
    const down = cutAccrued(
      { ...cut, tdsBp: 200 },
      120_000,
      { cut: 12_712, gst: 2_288, tds: 254 },
      2,
      T,
    );
    expect(down?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['agency-cuts', 0, 2_543],
      ['gst-input', 0, 457],
      ['agency-payable', 2_949, 0],
      ['tds-payable', 51, 0],
    ]);
  });

  it('an aggregator not registered for GST: 2% and no GST', () => {
    const e = cutAccrued(
      { ...cut, kind: 'aggregator', rateBp: 200, gstBp: 0 },
      150_000,
      { cut: 0, gst: 0, tds: 0 },
      1,
      T,
    );
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['aggregator-cuts', 3_000, 0],
      ['aggregator-payable', 0, 3_000],
    ]);
  });

  it('property: every cut entry balances, going up or down, and lands exactly on the target', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000_000 }), { minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 3_000 }),
        fc.constantFrom(0, 500, 1_200, 1_800, 2_800),
        fc.constantFrom(0, 100, 200, 500, 1_000),
        (earnings, rateBp, gstBp, tdsBp) => {
          const c = { ...cut, rateBp, gstBp, tdsBp };
          let so = { cut: 0, gst: 0, tds: 0 };
          earnings.forEach((earned, i) => {
            const e = cutAccrued(c, earned, so, i + 1, T);
            if (!e) return;
            expect(checkEntry(e)).toEqual([]);
            const b = balances([e]);
            so = {
              cut: so.cut + (b.get('agency-cuts') ?? 0),
              gst: so.gst + (b.get('gst-input') ?? 0),
              tds: so.tds + (b.get('tds-payable') ?? 0),
            };
          });
          const last = earnings[earnings.length - 1] ?? 0;
          // In all, the cut is its rate of the last delivered figure, GST included.
          const total = Math.floor((last * rateBp + 5_000) / 10_000);
          expect(so.cut + so.gst).toBe(total);
          expect(Math.abs(so.cut * (10_000 + gstBp) - total * 10_000)).toBeLessThanOrEqual(
            (10_000 + gstBp) / 2,
          );
          expect(so.tds).toBe(Math.floor((so.cut * tdsBp + 5_000) / 10_000));
        },
      ),
    );
  });
});
