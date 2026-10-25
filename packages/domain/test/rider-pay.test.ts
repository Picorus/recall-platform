import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { balances, checkEntry, type Entry } from '../src/ledger.js';
import { checkPriceBook, PRICE_BOOK_V1 } from '../src/price-book.js';
import {
  checkRiderPayRules,
  DEFAULT_RIDER_PAY_RULES as RULES,
  pocBonusEntry,
  pocDayPaise,
  pocMonthBonus,
  pocBaseOf,
  pocMonthOf,
  riderPay,
  riderPayAccrued,
  soldShares,
} from '../src/rider-pay.js';

const H = 3600;
const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const month = (countedHours: number, soldPaise = 0, pocDays: number[] = [], daysInMonth = 30) => ({
  countedSeconds: countedHours * H,
  paidSeconds: Math.min(countedHours, 260) * H,
  soldPaise,
  pocDays,
  daysInMonth,
});

describe('POC pay (P1.7.6): flat base each month, founding bonus on hours, finishing bonus', () => {
  it('POC month 1 is the month the POC was first switched on; before it, none', () => {
    expect(
      ['2027-07', '2027-08', '2027-10', '2027-12'].map((m) => pocMonthOf('2027-08', m)),
    ).toEqual([undefined, 1, 3, 5]);
    expect(pocMonthOf(undefined, '2027-08')).toBeUndefined();
    // Longer than planned: the last base carries on.
    expect([1, 2, 3, 4].map((n) => pocBaseOf(RULES, n))).toEqual([
      200_000, 400_000, 600_000, 600_000,
    ]);
  });

  it('base ₹2,000 / ₹4,000 / ₹6,000 for a full month, exactly', () => {
    expect(riderPay(RULES, 1, month(0, 0, all(31), 31)).gross).toBe(200_000);
    expect(riderPay(RULES, 2, month(0, 0, all(30), 30)).gross).toBe(400_000);
    expect(riderPay(RULES, 3, month(0, 0, all(31), 31))).toEqual({
      poc: 600_000,
      hourly: 0,
      sold: 0,
      gross: 600_000,
      tds: 6_000,
      net: 594_000,
    });
  });

  it('a month the switch was flipped in: POC days get the base, regular days the hourly pay and sales share', () => {
    // POC to the 20th of a 30-day month, regular from the 21st: 20 days of ₹6,000 ÷ 30, + 40 h at ₹25.
    const p = riderPay(RULES, 3, month(40, 100_000, all(20), 30));
    expect(p).toMatchObject({ poc: 400_000, hourly: 100_000, sold: 25_000, gross: 525_000 });
  });

  it('a week of the base is 7 days of the month: ₹451.61 in August (₹2,000 ÷ 31 × 7)', () => {
    expect(riderPay(RULES, 1, month(0, 0, all(7), 31)).gross).toBe(45_161);
  });

  it('founding bonus: full at 150 h, in proportion from 100 h (125 h = ₹3,000, 140 h = ₹4,800), none below', () => {
    expect([99, 100, 125, 140, 150, 200].map((h) => pocMonthBonus(RULES, h * H))).toEqual([
      0, 0, 300_000, 480_000, 600_000, 600_000,
    ]);
    expect(pocMonthBonus(RULES, 150 * H - 1)).toBe(599_996); // rounded down, never more
  });

  it('property: the days always add up to exactly the month; the bonus never goes down with more hours', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: 28, max: 31 }),
        fc.integer({ min: 0, max: 300 * H }),
        (paise, n, seconds) => {
          const sum = all(n).reduce((t, d) => t + pocDayPaise(paise, n, d), 0);
          expect(sum).toBe(paise);
          expect(pocMonthBonus(RULES, seconds + 1)).toBeGreaterThanOrEqual(
            pocMonthBonus(RULES, seconds),
          );
        },
      ),
    );
  });

  it('a POC bonus a super admin gives, less 1% TDS, balances', () => {
    const e = pocBonusEntry(RULES, 'R-A', 480_000, '2027-08', 0);
    expect(checkEntry(e)).toEqual([]);
    expect(e.entryId).toBe('poc-bonus:R-A:2027-08');
    expect(e.postings.map((p) => [p.account, p.debit, p.credit])).toEqual([
      ['rider-earnings', 480_000, 0],
      ['rider-payable', 0, 475_200],
      ['tds-payable', 0, 4_800],
    ]);
    expect(pocBonusEntry(RULES, 'R-A', 300_000, undefined, 0).entryId).toBe('poc-finish:R-A');
  });
});

describe('pay after the POC (P1.7.5)', () => {
  it('₹25 a moving hour on hours up to 260, + 25% of what his hours sold', () => {
    const p = riderPay(RULES, undefined, month(270, 1_000_000));
    expect(p).toMatchObject({ hourly: 650_000, sold: 250_000, gross: 900_000, tds: 9_000 });
  });

  it('part hours to the nearest paisa; no POC pay after the POC', () => {
    const p = riderPay(RULES, undefined, { ...month(0, 0, all(30)), paidSeconds: 90 });
    expect(p).toMatchObject({ poc: 0, hourly: 63 }); // 90 s × ₹25/h = 62.5 paise; no POC pay
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
    expect(checkRiderPayRules({ ...RULES, tdsBp: 3_500 })).toEqual([
      'sold share must be at most 100% and TDS at most 30%',
    ]);
    expect(checkRiderPayRules({ ...RULES, perMovingHourPaise: 2.5 })).toEqual([
      'rider pay settings must be whole numbers',
    ]);
  });
});
