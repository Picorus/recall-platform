import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addPaise,
  formatRupees,
  paise,
  parseRupees,
  subtractPaise,
  type Paise,
} from '../src/money.js';

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

  it('refuses sums that would lose precision, even if a later amount brings them back', () => {
    const max = paise(Number.MAX_SAFE_INTEGER);
    expect(() => addPaise(max, paise(1))).toThrow(RangeError);
    expect(() => addPaise(max, paise(2), paise(-2))).toThrow(RangeError);
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
    ['123,456', 12_345_600],
    ['1,234', 123_400],
    ['0.5', 50],
  ])('reads %s as %i paise', (text, expected) => {
    expect(parseRupees(text)).toBe(expected);
  });

  it.each([
    '',
    'abc',
    '1.234',
    '1e5',
    '12.',
    '.5',
    '--5',
    '1,50,00',
    '1,234,56',
    '12,34',
    '1,00,000,00',
    '1 5 0 0',
    '007',
    '₹-5',
  ])('rejects "%s"', (text) => {
    expect(() => parseRupees(text)).toThrow(RangeError);
  });

  it('shows Indian digit grouping', () => {
    expect(formatRupees(paise(12_345_678))).toBe('₹1,23,456.78');
    expect(formatRupees(paise(1_500_000))).toBe('₹15,000.00');
    expect(formatRupees(paise(5))).toBe('₹0.05');
    expect(formatRupees(paise(-25_000))).toBe('-₹250.00');
  });

  it('refuses to show a fraction of a paisa', () => {
    expect(() => formatRupees(0.5 as Paise)).toThrow(RangeError);
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
