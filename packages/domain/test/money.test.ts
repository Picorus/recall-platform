import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addPaise, formatRupees, paise, parseRupees, subtractPaise } from '../src/money.js';

const safePaise = fc.integer({ min: -1e13, max: 1e13 }).map(paise);

describe('paise', () => {
  it('accepts whole numbers', () => {
    expect(paise(1_500_000)).toBe(1_500_000);
  });

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s',
    (bad) => {
      expect(() => paise(bad)).toThrow(RangeError);
    },
  );

  it('adding and subtracting always gives whole paise and undoes itself', () => {
    fc.assert(
      fc.property(safePaise, safePaise, (a, b) => {
        const sum = addPaise(a, b);
        expect(Number.isInteger(sum)).toBe(true);
        expect(addPaise(b, a)).toBe(sum);
        expect(subtractPaise(sum, b)).toBe(a);
      }),
    );
  });

  it('refuses sums that would lose precision', () => {
    expect(() => addPaise(paise(Number.MAX_SAFE_INTEGER), paise(1))).toThrow(RangeError);
  });
});

describe('rupee text', () => {
  it.each([
    ['15000', 1_500_000],
    ['15,000', 1_500_000],
    ['₹15,000.5', 1_500_050],
    ['1,23,456.78', 12_345_678],
    ['0.01', 1],
    ['-250', -25_000],
    ['-0', 0],
    ['-₹0.01', -1],
    [' ₹ 1,500 ', 150_000],
  ])('reads %s as %i paise', (text, expected) => {
    expect(parseRupees(text)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1e5', '12.', '.5', '--5'])('rejects "%s"', (text) => {
    expect(() => parseRupees(text)).toThrow(RangeError);
  });

  it('shows Indian digit grouping', () => {
    expect(formatRupees(paise(12_345_678))).toBe('₹1,23,456.78');
    expect(formatRupees(paise(1_500_000))).toBe('₹15,000.00');
    expect(formatRupees(paise(5))).toBe('₹0.05');
    expect(formatRupees(paise(-25_000))).toBe('-₹250.00');
  });

  it('reading what we show gives back the same paise', () => {
    fc.assert(
      fc.property(safePaise, (amount) => {
        expect(parseRupees(formatRupees(amount))).toBe(amount);
      }),
      { numRuns: 2000 },
    );
  });
});
