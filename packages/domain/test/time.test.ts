import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { businessDayOf, formatIndiaTime, toIndiaTime } from '../src/time.js';

/** Builds a UTC instant from an India wall-clock time. */
function india(isoLocal: string): Date {
  return new Date(`${isoLocal}+05:30`);
}

describe('India time', () => {
  it('shows UTC instants in India time', () => {
    expect(formatIndiaTime(new Date('2026-10-22T17:45:00Z'))).toBe('2026-10-22 23:15 IST');
    expect(toIndiaTime(new Date('2026-10-22T20:00:00Z'))).toEqual({
      date: '2026-10-23',
      hour: 1,
      minute: 30,
    });
  });

  it('rejects invalid dates', () => {
    expect(() => formatIndiaTime(new Date('nope'))).toThrow(RangeError);
    expect(() => businessDayOf(new Date('nope'))).toThrow(RangeError);
  });
});

describe('business day (08:00–02:00 India time)', () => {
  it.each([
    ['2026-10-22T08:00', '2026-10-22'],
    ['2026-10-22T13:00', '2026-10-22'],
    ['2026-10-22T23:59', '2026-10-22'],
    ['2026-10-23T00:00', '2026-10-22'],
    ['2026-10-23T01:59', '2026-10-22'],
    ['2026-10-23T02:00', null],
    ['2026-10-23T07:59', null],
    ['2026-10-23T08:00', '2026-10-23'],
    ['2027-01-01T01:00', '2026-12-31'],
    ['2028-03-01T00:30', '2028-02-29'],
  ])('%s belongs to %s', (local, expected) => {
    expect(businessDayOf(india(local))).toBe(expected);
  });

  it('every minute from 08:00 to 02:00 belongs to the day it opened; 02:00–08:00 to none', () => {
    const day = fc
      .date({
        min: new Date('2026-01-01T00:00:00Z'),
        max: new Date('2035-12-31T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString().slice(0, 10));
    fc.assert(
      fc.property(day, fc.integer({ min: 0, max: 24 * 60 - 1 }), (date, minutesAfterOpening) => {
        const instant = new Date(india(`${date}T08:00`).getTime() + minutesAfterOpening * 60_000);
        const expected = minutesAfterOpening < 18 * 60 ? date : null;
        expect(businessDayOf(instant)).toBe(expected);
      }),
      { numRuns: 5000 },
    );
  });
});
