// P3.6: changing prices and rules as a new price book version.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PRICE_BOOK_V1 } from '../src/price-book.js';
import {
  applyPriceChange,
  BAND_NAMES,
  checkPriceChange,
  describePriceChange,
  firstVersionFrom,
  hourText,
  percentText,
  rupeeText,
  START_HOURS,
  type BandName,
} from '../src/price-editor.js';

const AT = '2026-12-01T06:00:00.000Z';

describe('prices and rules: the next version (P3.6)', () => {
  it('no book yet: version 1 is the plan’s book from now; it passes every rule', () => {
    const first = applyPriceChange(undefined, {}, AT);
    expect(first).toEqual({ ...PRICE_BOOK_V1, version: 1, validFrom: AT });
    expect(checkPriceChange(first)).toEqual([]);
    expect(describePriceChange(undefined, first)).toContainEqual({
      setting: 'Peak price a bike-hour',
      before: '',
      after: '₹300',
    });
  });

  it('changes only what is asked; every other setting is carried over', () => {
    const next = applyPriceChange(
      PRICE_BOOK_V1,
      { prices: { Peak: 32_000 }, hourBands: { 16: 'Peak' }, adsDueDays: 5 },
      AT,
    );
    expect(next.version).toBe(2);
    expect(next.bands.find((b) => b.name === 'Peak')).toEqual({
      name: 'Peak',
      startHours: [8, 9, 10, 16, 17, 18, 19, 20, 21, 22],
      paisePerBikeHour: 32_000,
    });
    expect(next.bands.find((b) => b.name === 'Normal')?.startHours).toEqual([11, 12, 13, 14, 15]);
    const { bands, version, validFrom, adsDueDays, ...rest } = next;
    const { bands: b0, version: v0, validFrom: f0, adsDueDays: a0, ...rest0 } = PRICE_BOOK_V1;
    expect(rest).toEqual(rest0);
    expect([bands.length, version, validFrom, adsDueDays, b0.length, v0, f0, a0]).toEqual([
      3,
      2,
      AT,
      5,
      3,
      1,
      PRICE_BOOK_V1.validFrom,
      7,
    ]);
    expect(checkPriceChange(next)).toEqual([]);
    expect(describePriceChange(PRICE_BOOK_V1, next)).toEqual([
      { setting: 'Peak price a bike-hour', before: '₹300', after: '₹320' },
      {
        setting: 'Peak hours',
        before: '08:00 09:00 10:00 17:00 18:00 19:00 20:00 21:00 22:00',
        after: '08:00 09:00 10:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00',
      },
      {
        setting: 'Normal hours',
        before: '11:00 12:00 13:00 14:00 15:00 16:00',
        after: '11:00 12:00 13:00 14:00 15:00',
      },
      {
        setting: 'Ads due',
        before: '7 days before the first hour',
        after: '5 days before the first hour',
      },
    ]);
  });

  it('refuses what would break selling: below the floor, an offer under the floor, ads due after the lead time, a slip', () => {
    const bad = (c: Parameters<typeof applyPriceChange>[1]) =>
      checkPriceChange(applyPriceChange(PRICE_BOOK_V1, c, AT));
    expect(bad({ prices: { Lite: 21_000 } })).toContain('Lite: below the floor');
    expect(bad({ offersBp: { 6: 800, 12: 3_000 } })).toContain(
      '12-month offer takes Normal below the floor',
    );
    expect(bad({ adsDueDays: 15 })).toContain(
      'ads must be due fewer days ahead than the portal lead time',
    );
    expect(bad({ prices: { Peak: 30_000_000 } })).toContain('Peak: over ₹1 lakh a bike-hour');
    expect(bad({ minBikesPerLine: 0 })).toContain('plays and bikes must be at least 1');
    expect(bad({ trialDays: 0 })).toContain(
      'a trial must be at least 1 day and 1 to 10,000 bike-hours',
    );
    expect(bad({ offersBp: { 48: 500 } })).toContain('offers are for 2 to 36 months');
    expect(bad({ floorPaisePerBikeHour: 0, prices: {} })).toContain('the floor must be above ₹0');
    expect(bad({ minBookingPaise: 150.5 })).toContain('minBookingPaise must be a whole number');
    expect(bad({ hourBands: { 30: 'Peak' } })).toContain(
      'every start hour from 08:00 to 01:00 must be in exactly one band',
    );
    expect(bad({ adsDueDays: 0 })).toContain(
      'ads must be due at least 1 day before the first hour',
    );
    expect(bad({ repeatSpreadBp: 0 })).toContain('the deal spread must be 1–100%');
    expect(bad({ offersBp: { 6: 0 } })).toContain(
      'the 6-month offer must be above 0% (or remove it)',
    );
    expect(bad({ offersBp: {} })).toEqual([]);
    // Raising the floor above a band price is refused; lowering it is fine.
    expect(bad({ floorPaisePerBikeHour: 25_000 })).toContain('Lite: below the floor');
    expect(bad({ floorPaisePerBikeHour: 20_000 })).toEqual([]);
  });

  it('any mix of hours to bands keeps every start hour in exactly one band', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.constantFrom(...START_HOURS.map(String)),
          fc.constantFrom<BandName>(...BAND_NAMES),
        ),
        (moves) => {
          const next = applyPriceChange(PRICE_BOOK_V1, { hourBands: moves }, AT);
          const hours = next.bands.flatMap((b) => b.startHours).sort((a, b) => a - b);
          expect(hours).toEqual(START_HOURS);
          for (const [h, name] of Object.entries(moves))
            expect(next.bands.find((b) => b.startHours.includes(Number(h)))?.name).toBe(name);
          expect(checkPriceChange(next)).toEqual([]);
        },
      ),
    );
  });

  it('the first version starts at 00:00 India time on the 1st of the month', () => {
    expect(firstVersionFrom(Date.UTC(2026, 11, 1, 6))).toBe('2026-11-30T18:30:00.000Z');
    expect(firstVersionFrom(Date.UTC(2026, 9, 26, 11))).toBe('2026-09-30T18:30:00.000Z');
    // 31 Oct 20:00 UTC is already 1 Nov in India.
    expect(firstVersionFrom(Date.UTC(2026, 9, 31, 20))).toBe('2026-10-31T18:30:00.000Z');
  });

  it('words: rupees with Indian grouping, percents, India hours', () => {
    expect(rupeeText(1_500_000)).toBe('₹15,000');
    expect(rupeeText(1_00_00_000_00)).toBe('₹1,00,00,000');
    expect(rupeeText(22_050)).toBe('₹220.50');
    expect(percentText(800)).toBe('8%');
    expect(percentText(1_250)).toBe('12.5%');
    expect(percentText(5)).toBe('0.05%');
    expect([8, 23, 24, 25].map(hourText)).toEqual(['08:00', '23:00', '00:00', '01:00']);
    expect(describePriceChange(PRICE_BOOK_V1, PRICE_BOOK_V1)).toEqual([]);
  });
});
