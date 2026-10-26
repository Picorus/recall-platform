import { describe, expect, it } from 'vitest';
import {
  changeOf,
  formOf,
  hourLabel,
  percentBox,
  readPercent,
  readRupees,
  readWhole,
  rupeesBox,
  type Book,
} from '../../lib/prices';

const BOOK: Book = {
  version: 1,
  validFrom: '2026-12-01T06:00:00.000Z',
  bands: [
    { name: 'Peak', startHours: [8, 9, 10, 17, 18, 19, 20, 21, 22], paisePerBikeHour: 30_000 },
    { name: 'Normal', startHours: [11, 12, 13, 14, 15, 16], paisePerBikeHour: 25_000 },
    { name: 'Lite', startHours: [23, 24, 25], paisePerBikeHour: 22_000 },
  ],
  gstBp: 1_800,
  repeatOffersBp: { 6: 800, 12: 1_200 },
  repeatSpreadBp: 2_000,
  floorPaisePerBikeHour: 22_000,
  minBikesPerLine: 5,
  minBookingPaise: 1_500_000,
  portalLeadDays: 15,
  adsDueDays: 7,
  trialDays: 7,
  trialBikeHours: 20,
  playsPerBikeHour: 200,
};

describe('prices page: reading what was typed (P3.6)', () => {
  it('rupees, percents and whole numbers exactly, with no float', () => {
    expect(readRupees('300')).toBe(30_000);
    expect(readRupees('₹1,500.5')).toBe(150_050);
    expect(readRupees(' 0.29 ')).toBe(29);
    expect(readRupees('15,000')).toBe(1_500_000);
    expect(readRupees('1.005')).toEqual({ problem: '"1.005" is not an amount in rupees' });
    expect(readRupees('-5')).toHaveProperty('problem');
    expect(readRupees('3e2')).toHaveProperty('problem');
    expect(readPercent('12.5%')).toBe(1_250);
    expect(readPercent('8')).toBe(800);
    expect(readPercent('0.05')).toBe(5);
    expect(readPercent('8.123')).toHaveProperty('problem');
    expect(readWhole('15')).toBe(15);
    expect(readWhole('1.5')).toHaveProperty('problem');
    expect([rupeesBox(22_050), rupeesBox(30_000), percentBox(1_250), percentBox(800)]).toEqual([
      '220.50',
      '300',
      '12.5',
      '8',
    ]);
    expect([hourLabel(8), hourLabel(24), hourLabel(25)]).toEqual(['08:00', '00:00', '01:00']);
  });

  it('the form as loaded changes nothing; only what was edited is sent', () => {
    expect(changeOf(BOOK, formOf(BOOK))).toEqual({ change: {} });
    const f = formOf(BOOK);
    const edited = {
      ...f,
      prices: { ...f.prices, Peak: '320' },
      hourBands: { ...f.hourBands, 16: 'Peak' as const },
      offers: [...f.offers, { months: '24', percent: '15' }],
      adsDays: '5',
    };
    expect(changeOf(BOOK, edited)).toEqual({
      change: {
        prices: { Peak: 32_000 },
        hourBands: { '16': 'Peak' },
        offersBp: { '6': 800, '12': 1_200, '24': 1_500 },
        adsDueDays: 5,
      },
    });
    // Blank offer rows are skipped; removing all offers sends an empty list.
    expect(changeOf(BOOK, { ...f, offers: [{ months: '', percent: '' }] })).toEqual({
      change: { offersBp: {} },
    });
  });

  it('says what cannot be read instead of sending it', () => {
    const f = formOf(BOOK);
    expect(changeOf(BOOK, { ...f, floor: 'abc' })).toEqual({
      problem: 'Floor: "abc" is not an amount in rupees',
    });
    expect(
      changeOf(BOOK, {
        ...f,
        offers: [
          { months: '6', percent: '8' },
          { months: '6', percent: '9' },
        ],
      }),
    ).toEqual({ problem: 'Two offers for 6 months' });
    expect(changeOf(BOOK, { ...f, minBikes: '' })).toHaveProperty('problem');
  });
});
