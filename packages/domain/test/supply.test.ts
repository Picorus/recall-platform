import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BookingLine } from '../src/bookings.js';
import { launchAreas } from '../src/launch-areas.js';
import { checkPriceBook, PRICE_BOOK_V1 } from '../src/price-book.js';
import {
  DEFAULT_CAPACITY_RULES as RULES,
  nearbyAreas,
  offerFor,
  sellableBikes,
  type WeekSupply,
} from '../src/supply.js';

const week = (date: string, distinctBikes: number, bikeHours = distinctBikes): WeekSupply => ({
  date,
  distinctBikes,
  bikeSeconds: bikeHours * 3600,
});

describe('sellable bikes after the POC (P1.3.7)', () => {
  it('the POC needs no forecast: the price book starts in POC mode', () => {
    expect(PRICE_BOOK_V1.capacity.mode).toBe('poc');
    expect(checkPriceBook({ ...PRICE_BOOK_V1, capacity: { ...RULES, mode: 'forecast' } })).toEqual(
      [],
    );
  });

  it('the level reached in 4 of the last 5 weeks, less 10% kept for make-ups', () => {
    const weeks = [
      week('2028-03-07', 160),
      week('2028-03-14', 150),
      week('2028-03-21', 175),
      week('2028-03-28', 140),
      week('2028-04-04', 155),
    ];
    // Sorted 175, 160, 155, 150, 140 → the 4th highest is 150 → 135 after the margin.
    expect(sellableBikes(weeks, RULES)).toBe(135);
  });

  it('only the last 5 weeks count', () => {
    const old = [week('2028-01-03', 500), week('2028-01-10', 500)];
    const recent = ['2028-03-07', '2028-03-14', '2028-03-21', '2028-03-28', '2028-04-04'].map((d) =>
      week(d, 100),
    );
    expect(sellableBikes([...old, ...recent], RULES)).toBe(90);
  });

  it('many bikes passing through briefly cannot be sold as full bike-hours', () => {
    // 300 different bikes, but only 80 bike-hours of riding time in the area.
    const weeks = ['2028-03-07', '2028-03-14', '2028-03-21', '2028-03-28'].map((d) =>
      week(d, 300, 80),
    );
    expect(sellableBikes(weeks, RULES)).toBe(72);
  });

  it("too little history: the super admin's starting estimate; no estimate: nothing is sold blind", () => {
    expect(sellableBikes([week('2028-03-07', 200)], RULES, 40)).toBe(40);
    expect(sellableBikes([], RULES)).toBe(0);
  });

  it('never more than the weakest of the weeks it relies on, never negative', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 5000 })), {
          minLength: 4,
          maxLength: 12,
        }),
        (raw) => {
          const weeks = raw.map(([d, h], i) =>
            week(
              `2028-${String(1 + Math.floor(i / 4)).padStart(2, '0')}-${String(1 + (i % 4) * 7).padStart(2, '0')}`,
              d,
              h,
            ),
          );
          const s = sellableBikes(weeks, RULES);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(Number.isInteger(s)).toBe(true);
          const recent = [...weeks].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5);
          const caps = recent
            .map((w) => Math.min(w.distinctBikes, Math.floor(w.bikeSeconds / 3600)))
            .sort((a, b) => b - a);
          expect(s).toBeLessThanOrEqual(caps[Math.min(4, caps.length) - 1] ?? 0);
        },
      ),
    );
  });
});

describe('offers and suggestions', () => {
  const areas = launchAreas().map((a) => ({ ...a, draft: false }));
  const nearby = nearbyAreas(areas, RULES.nearbyMeters);
  const madhapur = (bikes: number, startHour = 18, date = '2028-04-11'): BookingLine => ({
    areaId: 'hyd-madhapur',
    date,
    startHour,
    bikes,
  });

  it("Prateek's example: Madhapur 6–7 pm carries 150, brand A has 100, brand B asks for 100", () => {
    const free = (at: Pick<BookingLine, 'areaId' | 'date' | 'startHour'>) => {
      if (at.areaId === 'hyd-madhapur' && at.date === '2028-04-11' && at.startHour === 18)
        return 50;
      if (at.areaId === 'hyd-hitech-city' && at.startHour === 18) return 70;
      if (at.areaId === 'hyd-madhapur' && at.startHour === 19) return 90;
      return 0;
    };
    const offer = offerFor([madhapur(100)], free, nearby, 5);
    expect(offer.fits).toEqual([madhapur(50)]);
    expect(offer.short[0]?.missing).toBe(50);
    expect(
      offer.short[0]?.suggestions.map((s) => [
        s.line.areaId,
        s.line.startHour,
        s.line.bikes,
        s.why,
      ]),
    ).toEqual([
      ['hyd-hitech-city', 18, 50, 'nearby area'],
      ['hyd-madhapur', 19, 50, 'other hour'],
    ]);
  });

  it('no limit (POC): everything fits', () => {
    expect(offerFor([madhapur(500)], () => undefined, nearby, 5)).toEqual({
      fits: [madhapur(500)],
      short: [],
    });
  });

  it('never commits fewer than the minimum, and two lines on the same hour share what is free', () => {
    const offer = offerFor([madhapur(30), madhapur(30, 18, '2028-04-11')], () => 33, nearby, 5);
    expect(offer.fits).toEqual([madhapur(30)]);
    expect(offer.short[0]?.missing).toBe(30);
  });

  it('nearby areas are the nearest ones that are on, within 5 km', () => {
    expect(nearby.get('hyd-madhapur')?.[0]).toBe('hyd-hitech-city');
    expect(nearby.get('hyd-madhapur')).not.toContain('hyd-madhapur');
  });
});
