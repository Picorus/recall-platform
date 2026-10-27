import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_SIGN_IN as L } from '../src/brand-sign-in.js';
import { quote } from '../src/bookings.js';
import { launchAreas } from '../src/launch-areas.js';
import { PRICE_BOOK_V1 as B } from '../src/price-book.js';
import {
  earliestStart,
  hourLabel,
  planLines,
  planProblems,
  type PortalPlan,
} from '../src/portal-booking.js';

const plan: PortalPlan = {
  areaIds: ['hyd-madhapur', 'hyd-gachibowli'],
  hours: [19, 20],
  weekdays: [5, 6],
  startDate: '2027-09-06',
  weeks: 2,
  bikes: 10,
  repeatMonths: 1,
};

describe('booking on the portal (P5.4)', () => {
  it('a plan becomes one line per area, day and hour', () => {
    const lines = planLines(plan);
    // 2 weeks × Fri, Sat × 2 areas × 2 hours.
    expect(lines).toHaveLength(16);
    expect(new Set(lines.map((l) => l.date))).toEqual(
      new Set(['2027-09-10', '2027-09-11', '2027-09-17', '2027-09-18']),
    );
    expect(lines.every((l) => l.bikes === 10)).toBe(true);
  });

  it('a monthly repeat repeats the weeks each month and passes the deal spread check', () => {
    const p = { ...plan, repeatMonths: 6, weeks: 1 };
    const lines = planLines(p);
    expect(lines).toHaveLength(6 * 2 * 2 * 2);
    const areas = launchAreas('2026-11-01T00:00:00.000Z').map((a) => ({ ...a, draft: false }));
    const q = quote(
      { lines, repeatMonths: 6, channel: 'portal' },
      B,
      areas,
      Date.UTC(2027, 7, 1) / 1000,
    );
    expect(q.discount).toBeGreaterThan(0);
  });

  it('property: any plan with a monthly repeat is spread evenly enough for the deal', () => {
    const areas = launchAreas('2026-11-01T00:00:00.000Z').map((a) => ({ ...a, draft: false }));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }),
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(6, 12),
        (offset, weekdays, weeks, repeatMonths) => {
          const startDate = new Date(Date.UTC(2027, 8, 1) + offset * 86_400_000)
            .toISOString()
            .slice(0, 10);
          const lines = planLines({
            ...plan,
            areaIds: ['hyd-madhapur'],
            hours: [19],
            weekdays,
            weeks,
            startDate,
            repeatMonths,
            bikes: 50,
          });
          const q = quote(
            { lines, repeatMonths, channel: 'admin' },
            B,
            areas,
            Date.UTC(2027, 7, 1) / 1000,
          );
          expect(q.discount).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses what cannot be booked, in plain words', () => {
    expect(planProblems(plan, B, L)).toEqual([]);
    expect(planProblems({ ...plan, bikes: 4 }, B, L)).toEqual(['From 5 to 100 bikes each hour']);
    expect(planProblems({ ...plan, bikes: 101 }, B, L)).toEqual(['From 5 to 100 bikes each hour']);
    expect(planProblems({ ...plan, areaIds: [], hours: [7] }, B, L)).toEqual([
      'Pick at least one area',
      'Hours run from 8 am to 1 am',
    ]);
    expect(planProblems({ ...plan, repeatMonths: 3 }, B, L)).toContain(
      'Repeat for 6 or 12 months, or not at all',
    );
    expect(planProblems({ ...plan, startDate: '2027-02-30' }, B, L)).toEqual(['Pick a start date']);
    // A huge plan is refused from its size alone, before any line is made.
    const huge = {
      ...plan,
      areaIds: Array.from({ length: 100 }, (_, i) => `a-${i}`),
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      weeks: 4,
      repeatMonths: 12,
    };
    expect(planProblems(huge, B, L)).toEqual([
      'Too many hours for one booking: book it in parts, or call us',
    ]);
    expect(planLines(huge)).toEqual([]);
    expect(planProblems({ ...plan, repeatMonths: 6, weeks: 5 }, B, L)).toContain(
      'A monthly repeat runs up to 4 weeks a month',
    );
  });

  it('hours in words; the earliest start', () => {
    expect([8, 12, 19, 24, 25].map(hourLabel)).toEqual([
      '8 am',
      '12 noon',
      '7 pm',
      '12 midnight',
      '1 am',
    ]);
    // 23 Aug 2027 10:00 India: 15 days' lead → from 8 Sep.
    expect(earliestStart(Date.UTC(2027, 7, 23, 4, 30) / 1000, B)).toBe('2027-09-08');
  });
});
