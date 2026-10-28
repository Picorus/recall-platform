// P7.7.7: the sums and labels behind the portals' charts and folds.
import { describe, expect, it } from 'vitest';
import {
  businessDay,
  compactIndian,
  daysOfMonth,
  dayLabel,
  foldHint,
  hourLabel,
  indiaDate,
  labelEvery,
  latestOf,
  monthLabel,
  monthsBetween,
  niceTicks,
  peak,
  position,
  rupeesShort,
  sumByIndiaDay,
  sumByIndiaMonth,
} from '../src/chart-math';

/** A small seeded random source, so the "many cases" tests are the same on every run. */
function random(seed: number) {
  let x = seed >>> 0;
  return (lo: number, hi: number) => {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    return lo + (x % (hi - lo + 1));
  };
}

/** 28 Oct 2026, 00:00 India time, in UTC seconds. */
const OCT28 = Date.UTC(2026, 9, 27, 18, 30) / 1000;

describe('niceTicks', () => {
  it('rounds the axis to 1, 2 or 5 times a power of ten, from 0', () => {
    expect(niceTicks([47, 94, 12]).ticks).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks([1240]).ticks).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks([3]).ticks).toEqual([0, 1, 2, 3]);
    expect(niceTicks([135_000_00]).max).toBe(15_000_000);
  });

  it('covers negative amounts (a month of more credit notes than invoices)', () => {
    const t = niceTicks([-30, 80]);
    expect(t.min).toBeLessThanOrEqual(-30);
    expect(t.max).toBeGreaterThanOrEqual(80);
    expect(t.ticks).toContain(0);
  });

  it('has something to draw when every value is 0 or there are none', () => {
    expect(niceTicks([0, 0]).ticks).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks([]).max).toBeGreaterThan(0);
  });

  it('keeps whole steps for whole values, and allows fractions when asked', () => {
    expect(niceTicks([2], 4, true).step).toBe(1);
    expect(niceTicks([0.6], 3, false).ticks).toEqual([0, 0.2, 0.4, 0.6]);
  });

  it('always covers every value with at most a dozen round steps', () => {
    const r = random(7);
    for (let run = 0; run < 500; run++) {
      const big = 10 ** r(0, 9);
      const values = Array.from({ length: r(0, 40) }, () => r(-big, big));
      const t = niceTicks(values);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(t.min);
        expect(v).toBeLessThanOrEqual(t.max);
      }
      expect(t.ticks[0]).toBe(t.min);
      expect(t.ticks.at(-1)).toBe(t.max);
      expect(t.ticks.length).toBeLessThanOrEqual(12);
      expect(Number.isInteger(t.step)).toBe(true);
      expect(t.ticks).toContain(0);
    }
  });
});

describe('position', () => {
  it('maps the axis to 0–100 and clamps', () => {
    expect(position(50, { min: 0, max: 200 })).toBe(25);
    expect(position(-5, { min: 0, max: 10 })).toBe(0);
    expect(position(20, { min: 0, max: 10 })).toBe(100);
    expect(position(3, { min: 3, max: 3 })).toBe(0);
  });
});

describe('numbers, Indian style', () => {
  it('shortens to K, lakh and crore', () => {
    expect(compactIndian(950)).toBe('950');
    expect(compactIndian(1_240)).toBe('1.2K');
    expect(compactIndian(12_400)).toBe('12K');
    expect(compactIndian(1_35_000)).toBe('1.4L');
    expect(compactIndian(34_00_000)).toBe('34L');
    expect(compactIndian(3_40_00_000)).toBe('3.4Cr');
    expect(compactIndian(-1_500)).toBe('−1.5K');
    expect(compactIndian(0)).toBe('0');
    expect(compactIndian(2_000)).toBe('2K');
  });

  it('writes whole paise as short rupees', () => {
    expect(rupeesShort(0)).toBe('₹0');
    expect(rupeesShort(95_000)).toBe('₹950');
    expect(rupeesShort(1_35_000_00)).toBe('₹1.4L');
    expect(rupeesShort(-50_000)).toBe('−₹500');
  });
});

describe('India time', () => {
  it('dates a UTC time in India', () => {
    expect(indiaDate(OCT28)).toBe('2026-10-28');
    expect(indiaDate(OCT28 - 1)).toBe('2026-10-27');
  });

  it('keeps 23:00–02:00 with the business day it started, and 02:00–08:00 too', () => {
    expect(businessDay(OCT28 + 1 * 3600)).toBe('2026-10-27'); // 1am on the 28th
    expect(businessDay(OCT28 + 2 * 3600)).toBe('2026-10-28'); // 2am
    expect(businessDay(OCT28 + 23 * 3600)).toBe('2026-10-28'); // 11pm
  });

  it('labels hours, days and months', () => {
    expect([0, 8, 12, 13, 23, 24, 25].map(hourLabel)).toEqual([
      '12am',
      '8am',
      '12pm',
      '1pm',
      '11pm',
      '12am',
      '1am',
    ]);
    expect(dayLabel('2026-10-08')).toBe('8 Oct');
    expect(dayLabel('2026-10-08', true)).toBe('8 Oct 2026');
    expect(monthLabel('2027-01')).toBe('Jan');
    expect(monthLabel('2027-01', true)).toBe('Jan 2027');
  });

  it('lists months across a year end', () => {
    expect(monthsBetween('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
    expect(monthsBetween('2027-02', '2026-11')).toEqual([]);
  });

  it('adds up by India month: 31 Oct 11pm India is October, not November', () => {
    const lateOct31 = Date.UTC(2026, 9, 31, 17, 30) / 1000; // 11pm India
    const nov1 = Date.UTC(2026, 9, 31, 18, 30) / 1000; // midnight India
    expect(
      sumByIndiaMonth(
        [
          { at: lateOct31, value: 100 },
          { at: nov1, value: 7 },
          { at: nov1 + 86_400 * 60, value: 999 }, // outside the months asked: left out
        ],
        ['2026-10', '2026-11'],
      ),
    ).toEqual([
      { month: '2026-10', value: 100 },
      { month: '2026-11', value: 7 },
    ]);
  });

  it('adds up by India day: 11:30pm and 12:30am India fall on two days', () => {
    expect(
      sumByIndiaDay(
        [
          { at: OCT28 - 1800, value: 5 },
          { at: OCT28 + 1800, value: 7 },
          { at: OCT28 + 3600, value: 1 },
        ],
        ['2026-10-27', '2026-10-28', '2026-10-29'],
      ),
    ).toEqual([
      { day: '2026-10-27', value: 5 },
      { day: '2026-10-28', value: 8 },
      { day: '2026-10-29', value: 0 },
    ]);
  });

  it('lists every day of a month, leap years too', () => {
    expect(daysOfMonth('2026-10')).toHaveLength(31);
    expect(daysOfMonth('2027-02').at(-1)).toBe('2027-02-28');
    expect(daysOfMonth('2028-02').at(-1)).toBe('2028-02-29');
    expect(daysOfMonth('2026-11')[0]).toBe('2026-11-01');
  });

  it('never loses or makes up an amount inside the months', () => {
    const months = monthsBetween('2026-04', '2027-03');
    const from = Date.UTC(2026, 2, 31, 18, 30) / 1000;
    const until = Date.UTC(2027, 2, 31, 18, 30) / 1000;
    const r = random(11);
    for (let run = 0; run < 200; run++) {
      const items = Array.from({ length: r(0, 60) }, () => ({
        at: r(from, until - 1),
        value: r(-1e9, 1e9),
      }));
      const sums = sumByIndiaMonth(items, months);
      expect(sums).toHaveLength(12);
      expect(sums.reduce((n, x) => n + x.value, 0)).toBe(items.reduce((n, x) => n + x.value, 0));
    }
  });
});

describe('labels and folds', () => {
  it('thins the labels under a long axis', () => {
    expect(labelEvery(18)).toBe(3);
    expect(labelEvery(5)).toBe(1);
    expect(labelEvery(30, 6)).toBe(5);
  });

  it('finds the peak (the first on a tie)', () => {
    expect(peak([{ value: 1 }, { value: 5, k: 'a' }, { value: 5, k: 'b' }])).toEqual({
      value: 5,
      k: 'a',
    });
    expect(peak([])).toBeUndefined();
  });

  it('says how many and when the latest was', () => {
    expect(foldHint(12, ['entry', 'entries'], OCT28 + 3600)).toBe('12 entries, latest 28 Oct');
    expect(foldHint(1, ['note', 'notes'], '2026-10-03')).toBe('1 note, latest 3 Oct');
    expect(foldHint(0, ['note', 'notes'])).toBe('No notes yet');
    expect(foldHint(1_500, ['play', 'plays'])).toBe('1,500 plays');
    expect(foldHint(2, ['note', 'notes'], '2025-12-30', OCT28)).toBe('2 notes, latest 30 Dec 2025');
    expect(foldHint(2, ['note', 'notes'], '2026-12-30', OCT28)).toBe('2 notes, latest 30 Dec');
    expect(latestOf([3, 9, 1])).toBe(9);
    expect(latestOf([])).toBeUndefined();
  });
});
