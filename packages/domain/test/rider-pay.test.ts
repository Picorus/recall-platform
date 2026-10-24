import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { balances, checkEntry, type Entry } from '../src/ledger.js';
import { checkPriceBook, PRICE_BOOK_V1 } from '../src/price-book.js';
import {
  checkRiderPayRules,
  DEFAULT_RIDER_PAY_RULES as POC,
  riderPay,
  riderPayAccrued,
  soldShares,
} from '../src/rider-pay.js';

const STANDARD = { ...POC, mode: 'standard' as const };
const H = 3600;
const month = (countedHours: number, base?: number, soldPaise = 0) => ({
  countedSeconds: countedHours * H,
  paidSeconds: Math.min(countedHours, 260) * H,
  soldPaise,
  pocBasePaise: base,
});

describe('POC pay (P1.7.6)', () => {
  it('nothing until the month ends; then base + ₹6,000 bonus at 150 hours, 1% TDS', () => {
    expect(riderPay(POC, month(200, 600_000), false).gross).toBe(0);
    expect(riderPay(POC, month(150, 600_000), true)).toEqual({
      base: 600_000,
      bonus: 600_000,
      hourly: 0,
      sold: 0,
      gross: 1_200_000,
      tds: 12_000,
      net: 1_188_000,
    });
  });

  it('no part bonus below 150 hours: one second short, no bonus', () => {
    const p = riderPay(POC, { ...month(150, 200_000), countedSeconds: 150 * H - 1 }, true);
    expect([p.bonus, p.gross]).toEqual([0, 200_000]);
  });
});

describe('pay after the POC (P1.7.5)', () => {
  it('₹25 a moving hour on hours up to 260, + 25% of what his hours sold', () => {
    const p = riderPay(STANDARD, month(270, undefined, 1_000_000), false);
    expect(p).toMatchObject({ hourly: 650_000, sold: 250_000, gross: 900_000, tds: 9_000 });
  });

  it('part hours to the nearest paisa; no POC base or bonus', () => {
    const p = riderPay(STANDARD, { ...month(0, 600_000), paidSeconds: 90 }, true);
    expect(p).toMatchObject({ base: 0, bonus: 0, hourly: 63 }); // 90 s × ₹25/h = 62.5 paise
  });
});

describe('sharing what a line sold between the screens that delivered it', () => {
  it('each counted play is worth paid ÷ promised; extra plays add nothing', () => {
    const keys = [...Array<string>(200).fill('R-A'), ...Array<string>(200).fill('R-B')];
    expect([...soldShares(150_000, 1_000, keys)]).toEqual([
      ['R-A', 30_000],
      ['R-B', 30_000],
    ]);
    const over = [...Array<string>(900).fill('R-A'), ...Array<string>(300).fill('R-B')];
    expect([...soldShares(150_000, 1_000, over)]).toEqual([
      ['R-A', 112_500],
      ['R-B', 37_500],
    ]);
    expect(soldShares(0, 1_000, keys).size).toBe(0);
  });

  it('property: the shares never add up to more than the line was paid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 2_000 }),
        fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 3_000 }),
        (paid, promised, keys) => {
          const total = [...soldShares(paid, promised, keys).values()].reduce((a, b) => a + b, 0);
          expect(total).toBeLessThanOrEqual(paid);
          // Never short by more than a paisa per rider (rounding down).
          if (keys.length >= promised) expect(paid - total).toBeLessThanOrEqual(4);
        },
      ),
    );
  });
});

describe('rider pay in the ledger', () => {
  it('earnings owed to the rider less TDS; TDS owed to the government', () => {
    const e = riderPayAccrued(
      'R-A',
      '2027-08',
      { gross: 1_200_000, tds: 12_000 },
      { gross: 0, tds: 0 },
      1,
      0,
    );
    expect(checkEntry(e as Entry)).toEqual([]);
    expect(e?.entryId).toBe('rider-pay:R-A:2027-08:1');
    expect(e?.postings.map((p) => [p.account, p.debit, p.credit, p.party])).toEqual([
      ['rider-earnings', 1_200_000, 0, 'R-A'],
      ['rider-payable', 0, 1_188_000, 'R-A'],
      ['tds-payable', 0, 12_000, 'R-A'],
    ]);
    expect(
      riderPayAccrued('R-A', '2027-08', { gross: 5, tds: 0 }, { gross: 5, tds: 0 }, 2, 0),
    ).toBeUndefined();
  });

  it('property: up or down, every entry balances and lands exactly on the pay', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50_000_000 }), { minLength: 1, maxLength: 15 }),
        fc.constantFrom(0, 100, 200, 1_000),
        (grosses, tdsBp) => {
          let so = { gross: 0, tds: 0 };
          grosses.forEach((gross, i) => {
            const tds = Math.floor((gross * tdsBp + 5_000) / 10_000);
            const e = riderPayAccrued('R-A', '2027-09', { gross, tds }, so, i + 1, 0);
            if (!e) return;
            expect(checkEntry(e)).toEqual([]);
            const b = balances([e]);
            so = {
              gross: so.gross + (b.get('rider-earnings') ?? 0),
              tds: so.tds + (b.get('tds-payable') ?? 0),
            };
            expect(so).toEqual({ gross, tds });
          });
        },
      ),
    );
  });
});

describe('rider pay settings', () => {
  it('are checked with the price book', () => {
    expect(checkPriceBook(PRICE_BOOK_V1)).toEqual([]);
    expect(checkRiderPayRules({ ...POC, tdsBp: 3_500 })).toEqual([
      'sold share must be at most 100% and TDS at most 30%',
    ]);
    expect(checkRiderPayRules({ ...POC, perMovingHourPaise: 2.5 })).toEqual([
      'rider pay settings must be whole numbers',
    ]);
  });
});
