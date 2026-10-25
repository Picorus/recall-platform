import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkPeopleRules,
  DEFAULT_PEOPLE_RULES as RULES,
  indianNumber,
  peopleEstimate,
  peopleTotal,
} from '../src/people.js';
import { checkPriceBook, PRICE_BOOK_V1 } from '../src/price-book.js';
import { checkReport, keptOfRejected } from '../src/screen-reports.js';

const minute = {
  kind: 'minute',
  minute: 1_800_000_000,
  secondsAt: { 'inside:hyd-madhapur@1': 60 },
  clockSeconds: 0,
  clockAt: {},
  payClockSeconds: 0,
  movingSeconds: 0,
  distanceM: 0,
  plays: 4,
  people: 37,
};

describe('P1.8.1 only the number leaves the screen', () => {
  it('a report carrying anything more than its fields (a picture) is refused', () => {
    expect(checkReport(minute)).toBeUndefined();
    expect(checkReport({ ...minute, photo: 'data:image/jpeg;base64,/9j/4AAQ' })).toBe(
      'unknown field: photo',
    );
    expect(
      checkReport({ kind: 'live', t: 1, lat: 17, lng: 78, place: 'x', moving: true, face: [1] }),
    ).toBe('unknown field: face');
  });

  it('what is kept of a refused report never holds the picture, not even a piece of it', () => {
    const picture = `data:image/jpeg;base64,${'A'.repeat(50_000)}`;
    const kept = keptOfRejected({ ...minute, people: -1, photo: picture, frames: [picture] });
    const text = JSON.stringify(kept);
    expect(text).not.toContain('AAAA');
    expect(kept).toMatchObject({ kind: 'minute', people: -1, otherFields: ['photo', 'frames'] });
    // A picture hidden in a known text field is cut to a short piece.
    expect(JSON.stringify(keptOfRejected({ kind: 'play', place: picture })).length).toBeLessThan(
      300,
    );
    expect(keptOfRejected('not an object')).toEqual({ notAReport: 'string' });
  });

  it('found in review: an odd kind is refused instead of stopping the upload', () => {
    for (const kind of ['toString', 'constructor', '__proto__', 'hasOwnProperty'])
      expect(checkReport({ kind })).toBe('unknown kind');
  });

  it('found in review: picture bytes hidden in place names or field names are not kept', () => {
    const piece = (i: number) => `${i}`.padStart(3, '0') + 'Z'.repeat(77);
    const places = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [piece(i), 1]));
    const names = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x${piece(i)}`, 1]));
    const kept = keptOfRejected({ ...minute, secondsAt: places, clockAt: places, ...names });
    expect(kept.secondsAt).toEqual({ places: 40, seconds: 40 });
    expect(JSON.stringify(kept).length).toBeLessThan(700);
    const play = Object.fromEntries(
      ['keyId', 'slot', 'ref', 'adId', 'place', 'sig'].map((k) => [k, 'Z'.repeat(5_000)]),
    );
    expect(JSON.stringify(keptOfRejected({ kind: 'play', ...play })).length).toBeLessThan(400);
  });
});

describe('P1.8.3 people are shown as a rounded range, marked approximate', () => {
  it('2,40,000 people → 2.0–2.8 lakh (±15%, rounded outwards)', () => {
    expect(peopleEstimate(240_000)).toEqual({
      low: 200_000,
      high: 280_000,
      approximate: true,
      text: '2.0–2.8 lakh people (approximate)',
    });
  });

  it('small, large and none', () => {
    expect(peopleEstimate(1_000).text).toBe('850–1,200 people (approximate)');
    expect(peopleEstimate(90_000).text).toBe('76,000–1,10,000 people (approximate)');
    expect(peopleEstimate(9_500_000).text).toBe('80–110 lakh people (approximate)');
    expect(peopleEstimate(30_000_000).text).toBe('2.5–3.5 crore people (approximate)');
    expect(peopleEstimate(7).text).toBe('5–9 people (approximate)');
    expect(peopleEstimate(0).text).toBe('no people counted');
    expect(indianNumber(12_34_567)).toBe('12,34,567');
  });

  it('property: the true count is always inside the range, and the range is never wider than ±30%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), (n) => {
        const e = peopleEstimate(n);
        expect(e.low).toBeLessThanOrEqual(n);
        expect(e.high).toBeGreaterThanOrEqual(n);
        if (n >= 100) {
          expect(e.low).toBeGreaterThanOrEqual(n * 0.7);
          expect(e.high).toBeLessThanOrEqual(n * 1.3);
        }
        expect(e.text).toMatch(/approximate|no people/);
      }),
    );
  });

  it('a faulty chip cannot blow up a report: each play counts at most 150 people', () => {
    expect(peopleTotal([{ people: 20 }, { people: 90_000 }, { people: 150 }])).toEqual({
      people: 320,
      capped: 1,
    });
  });

  it('settings are checked with the price book', () => {
    expect(checkPriceBook(PRICE_BOOK_V1)).toEqual([]);
    expect(checkPeopleRules({ ...RULES, rangeBp: 0 })).toHaveLength(1);
    expect(checkPeopleRules({ ...RULES, perPlayMax: 1.5 })).toEqual([
      'people settings must be whole numbers',
    ]);
  });
});
