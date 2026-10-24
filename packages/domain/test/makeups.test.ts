import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineStartsAt } from '../src/bookings.js';
import {
  DEFAULT_MAKE_UP_RULES as RULES,
  discountShares,
  nextDecisionAt,
  makeUpWindows,
  missingPlays,
  nextSettlementStep,
  refundPaise,
  type Delivered,
  type LineSlot,
  type Settlement,
} from '../src/makeups.js';
import { checkPriceBook, PRICE_BOOK_V1 } from '../src/price-book.js';

const line = (startHour: number, date = '2027-08-24'): LineSlot => ({
  lineId: `BK-1/hyd-madhapur/${date}/${startHour}`,
  areaId: 'hyd-madhapur',
  date,
  startHour,
});
const NONE: Delivered = { line: 0, first: 0, second: 0 };

describe('where make-ups go (P1.6.2–3)', () => {
  it('6 pm line: first make-up 7–9 pm the same day, second 6–7 pm the next day', () => {
    const w = makeUpWindows(line(18));
    expect(w.first?.hours).toEqual([19, 20]);
    expect(w.first?.from).toBe(lineStartsAt({ date: '2027-08-24', startHour: 19 }));
    expect(w.first?.until).toBe(lineStartsAt({ date: '2027-08-24', startHour: 21 }));
    expect(w.second).toMatchObject({ date: '2027-08-25', hours: [18], stage: 2 });
    expect(w.first?.makeUpId).toBe('BK-1/hyd-madhapur/2027-08-24/18#1');
  });

  it('never after 02:00: a midnight line has only 01:00–02:00; a 01:00 line goes straight to the next day', () => {
    expect(makeUpWindows(line(24)).first?.hours).toEqual([25]);
    expect(makeUpWindows(line(25)).first).toBeUndefined();
    // 01:00 on the 24th's business day is the 25th at 01:00; next day the same.
    expect(makeUpWindows(line(25)).second.from).toBe(Date.UTC(2027, 7, 25, 19, 30) / 1000);
  });
});

describe('deciding, step by step (P1.6.1–4)', () => {
  const end = lineStartsAt({ date: '2027-08-24', startHour: 18 }) + 3600;

  it('nothing is decided before the hour ends + 10 minutes for late uploads', () => {
    expect(nextSettlementStep(line(18), 1000, {}, NONE, end + 599)).toBeUndefined();
    expect(nextSettlementStep(line(18), 1000, {}, { ...NONE, line: 900 }, end + 600)).toMatchObject(
      {
        step: 'first',
        owed: 100,
      },
    );
  });

  it('a full line needs nothing more; extra plays are a bonus', () => {
    expect(
      nextSettlementStep(line(18), 1000, {}, { ...NONE, line: 1200 }, end + 600),
    ).toMatchObject({
      step: 'first',
      owed: 0,
    });
    // Checked once more when the day closes (in case plays were later found fake), then done.
    const done: Settlement = { first: 'not needed' };
    const close = makeUpWindows(line(18)).second.until + RULES.dayCloseSeconds;
    expect(nextDecisionAt(line(18), done)).toBe(close);
    const full = { ...NONE, line: 1000 };
    expect(nextSettlementStep(line(18), 1000, done, full, close - 1)).toBeUndefined();
    expect(nextSettlementStep(line(18), 1000, done, full, close)).toEqual({
      step: 'refund',
      missing: 0,
    });
    expect(nextDecisionAt(line(18), { ...done, refund: 'not needed' })).toBeUndefined();
  });

  it('a line delivered in full whose plays are later found fake is refunded at day close', () => {
    const close = makeUpWindows(line(18)).second.until + RULES.dayCloseSeconds;
    expect(
      nextSettlementStep(line(18), 1000, { first: 'not needed' }, { ...NONE, line: 800 }, close),
    ).toEqual({ step: 'refund', missing: 200 });
  });

  it('still short after the first make-up → the next day; still short after that day closes → refund', () => {
    const w = makeUpWindows(line(18));
    const s1: Settlement = { first: { owed: 100 } };
    const d1 = { line: 900, first: 60, second: 0 };
    expect(nextSettlementStep(line(18), 1000, s1, d1, (w.first?.until ?? 0) + 599)).toBeUndefined();
    expect(nextSettlementStep(line(18), 1000, s1, d1, (w.first?.until ?? 0) + 600)).toMatchObject({
      step: 'second',
      owed: 40,
    });
    const s2: Settlement = { ...s1, second: { owed: 40 } };
    const d2 = { ...d1, second: 25 };
    const close = w.second.until + RULES.dayCloseSeconds;
    expect(nextSettlementStep(line(18), 1000, s2, d2, close - 1)).toBeUndefined();
    expect(nextSettlementStep(line(18), 1000, s2, d2, close)).toEqual({
      step: 'refund',
      missing: 15,
    });
    expect(
      nextSettlementStep(line(18), 1000, { ...s2, refund: { missing: 15 } }, d2, close + 1),
    ).toBeUndefined();
  });

  it('plays uploaded late still count when the next decision is made', () => {
    // At 7:10 pm 900 had arrived; by 9:10 pm late uploads bring the line itself to 980.
    const w = makeUpWindows(line(18));
    const step = nextSettlementStep(
      line(18),
      1000,
      { first: { owed: 100 } },
      { line: 980, first: 10, second: 0 },
      (w.first?.until ?? 0) + 600,
    );
    expect(step).toMatchObject({ step: 'second', owed: 10 });
  });

  it('property: missing plays are never negative and never more than promised', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        (promised, a, b, c) => {
          const m = missingPlays(promised, { line: a, first: b, second: c });
          expect(m).toBeGreaterThanOrEqual(0);
          expect(m).toBeLessThanOrEqual(promised);
          expect(m).toBe(Math.max(0, promised - a - b - c));
        },
      ),
    );
  });
});

describe('the refund (P1.6.4)', () => {
  it('missing plays ÷ 200 × the price paid per bike-hour', () => {
    // 20 bikes at ₹300 = ₹6,000 for 4,000 plays; 15 missing → 15/200 × ₹300 = ₹22.50.
    expect(refundPaise(15, 4000, 600_000)).toBe(2_250);
    expect(refundPaise(0, 4000, 600_000)).toBe(0);
    expect(refundPaise(4000, 4000, 600_000)).toBe(600_000);
  });

  it('rounded to the nearest paisa, halves up, in exact whole-number maths', () => {
    expect(refundPaise(1, 3, 100)).toBe(33);
    expect(refundPaise(2, 3, 100)).toBe(67);
    expect(refundPaise(1, 2, 1)).toBe(1);
    // Numbers far beyond what floats hold exactly.
    expect(refundPaise(1, 3, 9_000_000_000_000)).toBe(3_000_000_000_000);
  });

  it('property: never negative, never more than paid, more missing never refunds less', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (promised, paid, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const r1 = refundPaise(lo, promised, paid);
          const r2 = refundPaise(hi, promised, paid);
          expect(r1).toBeGreaterThanOrEqual(0);
          expect(r2).toBeLessThanOrEqual(paid);
          expect(r1).toBeLessThanOrEqual(r2);
        },
      ),
    );
  });

  it('a 6-month deal line refunds what was paid after the discount', () => {
    // ₹6,000 + ₹6,000 discounted lines, ₹960 off: each line's share is ₹480; a Lite line gets none.
    expect(
      discountShares(
        [
          { paise: 600_000, discounted: true },
          { paise: 600_000, discounted: true },
          { paise: 110_000, discounted: false },
        ],
        96_000,
      ),
    ).toEqual([48_000, 48_000, 0]);
  });

  it('shares add up exactly to the discount, so what the lines were paid adds up to the bill', () => {
    // The reviewer's case: ₹333.33 a bike-hour, 8% off, lines of 5, 5 and 7 bikes.
    const lines = [166_665, 166_665, 233_331].map((paise) => ({ paise, discounted: true }));
    const total = 566_661;
    const discount = Math.floor((total * 800 + 5_000) / 10_000);
    expect(discountShares(lines, discount).reduce((a, b) => a + b, 0)).toBe(discount);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ paise: fc.integer({ min: 0, max: 10_000_000 }), discounted: fc.boolean() }),
          { minLength: 1, maxLength: 30 },
        ),
        fc.integer({ min: 0, max: 9_999 }),
        (ls, bp) => {
          const t = ls.reduce((n, l) => n + (l.discounted ? l.paise : 0), 0);
          const d = Math.floor((t * bp) / 10_000);
          const shares = discountShares(ls, d);
          expect(shares.reduce((a, b) => a + b, 0)).toBe(t === 0 ? 0 : d);
          shares.forEach((x, i) => {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(ls[i]?.discounted ? (ls[i]?.paise ?? 0) : 0);
          });
        },
      ),
    );
  });

  it('make-up settings are checked with the price book', () => {
    expect(checkPriceBook(PRICE_BOOK_V1)).toEqual([]);
    expect(
      checkPriceBook({ ...PRICE_BOOK_V1, makeUps: { ...PRICE_BOOK_V1.makeUps, nextHours: 9 } }),
    ).toEqual(['make-up settings must be whole numbers; at most 4 next hours']);
  });

  it('cancellation and cut settings are checked too', () => {
    expect(checkPriceBook({ ...PRICE_BOOK_V1, cancelRefundDecideHours: 0 })).toEqual([
      'cancelRefundDecideHours must be at least 1',
    ]);
    expect(checkPriceBook({ ...PRICE_BOOK_V1, cuts: { agency: 0, aggregator: 200 } })).toEqual([
      'a cut rate must be 0.01–50%',
    ]);
    expect(
      checkPriceBook({ ...PRICE_BOOK_V1, cuts: { agency: 1_000, aggregator: 5_001 } }),
    ).toEqual(['a cut rate must be 0.01–50%']);
    expect(checkPriceBook({ ...PRICE_BOOK_V1, cutTdsBp: 2_500 })).toEqual([
      'TDS on a cut must be 0–20%',
    ]);
  });
});
