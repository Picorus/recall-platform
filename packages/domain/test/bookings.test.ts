import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  areaHourKey,
  capacityProblems,
  stepProblem,
  timingOf,
  trialProblem,
  type BookingState,
  type Hold,
} from '../src/booking-flow.js';
import {
  BookingError,
  lineStartsAt,
  quote,
  type BookingLine,
  type BookingRequest,
} from '../src/bookings.js';
import { launchAreas } from '../src/launch-areas.js';
import {
  bikeHourPaise,
  checkPriceBook,
  PRICE_BOOK_V1 as BOOK,
  priceBookAt,
} from '../src/price-book.js';

// Areas as sold (drafts approved), and "now" = Mon 23 Aug 2027, 10:00 India time.
const AREAS = launchAreas('2026-11-01T00:00:00.000Z').map((a) => ({ ...a, draft: false }));
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const DAY = 86_400;

const line = (areaId: string, date: string, startHour: number, bikes: number): BookingLine => ({
  areaId,
  date,
  startHour,
  bikes,
});
const req = (lines: BookingLine[], over: Partial<BookingRequest> = {}): BookingRequest => ({
  lines,
  repeatMonths: 1,
  channel: 'admin',
  ...over,
});
const problems = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as BookingError).problems.map((p) => p.kind);
  }
  return [];
};

describe('price book (settings, hard rule 8)', () => {
  it('version 1 is valid and matches rulebook v5.4', () => {
    expect(checkPriceBook(BOOK)).toEqual([]);
    expect([8, 17, 22].map((h) => bikeHourPaise(BOOK, h))).toEqual([30_000, 30_000, 30_000]);
    expect([11, 16].map((h) => bikeHourPaise(BOOK, h))).toEqual([25_000, 25_000]);
    expect([23, 24, 25].map((h) => bikeHourPaise(BOOK, h))).toEqual([22_000, 22_000, 22_000]);
  });

  it('6- and 12-month deals: 8% / 12% off the bill, on Peak and Normal hours only', () => {
    expect(BOOK.repeatOffersBp).toEqual({ 6: 800, 12: 1_200 });
    expect(BOOK.repeatOfferBands).toEqual(['Peak', 'Normal']);
  });

  it('a book with a gap in the hours or a price below the floor cannot be saved', () => {
    const gap = {
      ...BOOK,
      bands: BOOK.bands.map((b) => ({ ...b, startHours: b.startHours.filter((h) => h !== 12) })),
    };
    expect(checkPriceBook(gap)).not.toEqual([]);
    const cheap = { ...BOOK, bands: BOOK.bands.map((b) => ({ ...b, paisePerBikeHour: 10_000 })) };
    expect(checkPriceBook(cheap)).not.toEqual([]);
  });

  it('the book in force at a time; a booking keeps the version it was sold on', () => {
    const v2 = { ...BOOK, version: 2, validFrom: '2027-04-01T00:00:00.000Z' };
    expect(priceBookAt([BOOK, v2], '2027-03-31T23:59:59.000Z')?.version).toBe(1);
    expect(priceBookAt([BOOK, v2], '2027-04-01T00:00:00.000Z')?.version).toBe(2);
    expect(priceBookAt([BOOK, v2], '2026-01-01T00:00:00.000Z')).toBeUndefined();
  });
});

describe('when an hour starts (India time, stored in UTC)', () => {
  it('8 am, and 1 am that still belongs to the business day it started', () => {
    expect(new Date(lineStartsAt({ date: '2027-08-23', startHour: 8 }) * 1000).toISOString()).toBe(
      '2027-08-23T02:30:00.000Z',
    );
    expect(new Date(lineStartsAt({ date: '2027-08-23', startHour: 25 }) * 1000).toISOString()).toBe(
      '2027-08-23T19:30:00.000Z',
    );
    expect(() => lineStartsAt({ date: '2027-02-30', startHour: 8 })).toThrow(RangeError);
  });
});

describe('quotes (P1.3.1–P1.3.3)', () => {
  it('the admin sample: Biryani Hub, 180 peak bike-hours = ₹54,000 + GST ₹9,720 = ₹63,720', () => {
    const lines: BookingLine[] = [];
    for (const date of [
      '2027-08-27',
      '2027-08-28',
      '2027-08-29',
      '2027-09-03',
      '2027-09-04',
      '2027-09-05',
    ]) {
      lines.push(
        line('hyd-madhapur', date, 19, 10),
        line('hyd-madhapur', date, 20, 10),
        line('hyd-kondapur', date, 19, 10),
      );
    }
    const q = quote(req(lines), BOOK, AREAS, NOW);
    expect(q.bikeHours).toBe(180);
    expect(q.plays).toBe(36_000);
    expect([q.subtotal, q.gst, q.total]).toEqual([5_400_000, 972_000, 6_372_000]);
    expect(q.adsDueAt).toBe(q.firstHourAt - 7 * DAY);
  });

  it('refuses: fewer than 5 bikes, under ₹15,000, the same area-hour twice', () => {
    expect(
      problems(() => quote(req([line('hyd-madhapur', '2027-09-30', 18, 4)]), BOOK, AREAS, NOW)),
    ).toEqual(expect.arrayContaining(['too-few-bikes', 'below-minimum']));
    const dup = [
      line('hyd-madhapur', '2027-09-30', 18, 30),
      line('hyd-madhapur', '2027-09-30', 18, 30),
    ];
    expect(problems(() => quote(req(dup), BOOK, AREAS, NOW))).toContain('duplicate-line');
  });

  it('portal brands need 15 days; staff can book for tomorrow; nobody books the past', () => {
    const tomorrow = [line('hyd-madhapur', '2027-08-24', 18, 50)];
    expect(problems(() => quote(req(tomorrow, { channel: 'portal' }), BOOK, AREAS, NOW))).toEqual([
      'too-soon',
    ]);
    expect(quote(req(tomorrow), BOOK, AREAS, NOW).total).toBeGreaterThan(0);
    expect(
      problems(() => quote(req([line('hyd-madhapur', '2027-08-23', 9, 50)]), BOOK, AREAS, NOW)),
    ).toEqual(['in-the-past']);
  });

  it('refuses areas that are off, still drafts, or do not exist; and bad hours, dates and offers', () => {
    const off = AREAS.map((a) => (a.areaId === 'hyd-kondapur' ? { ...a, active: false } : a));
    const draft = AREAS.map((a) => (a.areaId === 'hyd-kondapur' ? { ...a, draft: true } : a));
    const l = [line('hyd-kondapur', '2027-09-30', 18, 60)];
    expect(problems(() => quote(req(l), BOOK, off, NOW))).toEqual(['area']);
    expect(problems(() => quote(req(l), BOOK, draft, NOW))).toEqual(['area']);
    expect(
      problems(() => quote(req([line('hyd-mars', '2027-09-30', 18, 60)]), BOOK, AREAS, NOW)),
    ).toEqual(['area']);
    expect(
      problems(() => quote(req([line('hyd-madhapur', '2027-09-30', 7, 60)]), BOOK, AREAS, NOW)),
    ).toEqual(['bad-line']);
    expect(
      problems(() => quote(req([line('hyd-madhapur', '2027-02-30', 18, 60)]), BOOK, AREAS, NOW)),
    ).toEqual(['bad-line']);
    expect(
      problems(() =>
        quote(
          req(
            l.map((x) => ({ ...x, areaId: 'hyd-madhapur' })),
            { repeatMonths: 3 },
          ),
          BOOK,
          AREAS,
          NOW,
        ),
      ),
    ).toEqual(['no-offer']);
  });

  it('money always adds up, in whole paise, never below the floor (any valid booking)', () => {
    const anyLine = fc.record({
      areaId: fc.constantFrom(...AREAS.map((a) => a.areaId)),
      date: fc
        .integer({ min: 20, max: 80 })
        .map((d) => new Date((NOW + d * DAY) * 1000).toISOString().slice(0, 10)),
      startHour: fc.integer({ min: 8, max: 25 }),
      bikes: fc.integer({ min: 5, max: 500 }),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(anyLine, { minLength: 1, maxLength: 30, selector: (l) => areaHourKey(l) }),
        fc.constantFrom(1, 6, 12),
        fc.constantFrom('portal', 'admin' as const),
        (lines, repeatMonths, channel) => {
          let q;
          try {
            q = quote({ lines, repeatMonths, channel }, BOOK, AREAS, NOW);
          } catch (e) {
            for (const p of (e as BookingError).problems)
              expect(['below-minimum', 'repeat-not-spread']).toContain(p.kind);
            return;
          }
          expect(q.listSubtotal).toBe(
            q.lines.reduce((n, l) => n + l.bikes * l.paisePerBikeHour, 0),
          );
          expect(q.subtotal).toBe(q.listSubtotal - q.discount);
          expect(q.discount).toBeGreaterThanOrEqual(0);
          expect(q.total).toBe(q.subtotal + q.gst);
          expect(Math.abs(q.gst - (q.subtotal * 18) / 100)).toBeLessThanOrEqual(0.5);
          for (const l of q.lines) {
            expect(l.paisePerBikeHour).toBeGreaterThanOrEqual(BOOK.floorPaisePerBikeHour);
            expect(l.plays).toBe(l.bikes * 200);
          }
          for (const n of [q.subtotal, q.gst, q.total]) expect(Number.isSafeInteger(n)).toBe(true);
          expect(q.subtotal).toBeGreaterThanOrEqual(BOOK.minBookingPaise);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('booking steps (P1.3.5)', () => {
  const t = timingOf(
    [line('hyd-madhapur', '2027-09-30', 18, 10), line('hyd-madhapur', '2027-09-30', 19, 10)],
    7,
  );
  const before = t.adsDueAt - 60;
  const during = t.firstHourAt + 60;
  const after = t.lastHourEndsAt + 60;

  it('the normal path, each step at its time', () => {
    const path: [BookingState, BookingState, number][] = [
      ['draft', 'awaiting-payment', before],
      ['awaiting-payment', 'paid', before],
      ['paid', 'ads-approved', before],
      ['ads-approved', 'running', during],
      ['running', 'done', after],
      ['done', 'report-sent', after],
    ];
    for (const [from, to, now] of path)
      expect(stepProblem(from, to, now, t, 'admin'), `${from}→${to}`).toBeUndefined();
  });

  it('refused: cancelling or approving ads after the start, running early, done early, skipping steps', () => {
    expect(stepProblem('paid', 'cancelled', during, t, 'admin')).toBeDefined();
    expect(stepProblem('paid', 'ads-approved', during, t, 'admin')).toBeDefined();
    expect(stepProblem('ads-approved', 'running', before, t, 'admin')).toBeDefined();
    expect(stepProblem('running', 'done', during, t, 'admin')).toBeDefined();
    expect(stepProblem('draft', 'paid', before, t, 'admin')).toBeDefined();
    expect(stepProblem('cancelled', 'paid', before, t, 'admin')).toBeDefined();
  });

  it('no ads by the first hour: ads missing (no refund, rulebook v5.4)', () => {
    expect(stepProblem('paid', 'ads-missing', during, t, 'admin')).toBeUndefined();
    expect(stepProblem('paid', 'ads-missing', before, t, 'admin')).toBeDefined();
  });
});

describe('holds and manual limits (P1.3.4)', () => {
  const l = line('hyd-madhapur', '2027-09-30', 18, 10);
  const key = areaHourKey(l);
  const hold: Hold = { holdId: 'h1', lines: [{ ...l, bikes: 30 }], until: NOW + 3600, by: 'priya' };

  it('no limit: always fits (no sell cap, DECISIONS 21 Oct)', () => {
    expect(
      capacityProblems(
        [{ ...l, bikes: 10_000 }],
        { limits: new Map(), sold: new Map(), holds: [hold] },
        NOW,
      ),
    ).toEqual([]);
  });

  it('with a limit: sold and live holds count; an ended hold or your own hold does not', () => {
    const inv = { limits: new Map([[key, 50]]), sold: new Map([[key, 15]]), holds: [hold] };
    expect(capacityProblems([l], inv, NOW)).toEqual([{ key, wanted: 10, free: 5 }]);
    expect(capacityProblems([l], inv, NOW + 3600)).toEqual([]);
    expect(capacityProblems([{ ...l, bikes: 35 }], inv, NOW, 'h1')).toEqual([]);
  });
});

describe('free trial (P1.3.6)', () => {
  const week = ['2027-09-01', '2027-09-02', '2027-09-03', '2027-09-04'].map((d) =>
    line('hyd-gachibowli', d, 18, 5),
  );

  it('one per business by phone or GST number, one area, 7 days, 20 bike-hours', () => {
    const biz = { phone: '+91 98490 12345', gstin: '36abcde1234f1z5' };
    expect(trialProblem(week, biz, new Set(), BOOK)).toBeUndefined();
    expect(trialProblem(week, biz, new Set(['phone:9849012345']), BOOK)).toBeDefined();
    expect(
      trialProblem(
        week,
        { phone: '000', gstin: '36ABCDE1234F1Z5' },
        new Set(['gstin:36ABCDE1234F1Z5']),
        BOOK,
      ),
    ).toBeDefined();
    expect(
      trialProblem([...week, line('hyd-madhapur', '2027-09-01', 18, 1)], biz, new Set(), BOOK),
    ).toMatch(/one area/);
    expect(
      trialProblem([...week, line('hyd-gachibowli', '2027-09-08', 18, 1)], biz, new Set(), BOOK),
    ).toMatch(/7 days/);
    expect(
      trialProblem([...week, line('hyd-gachibowli', '2027-09-05', 18, 1)], biz, new Set(), BOOK),
    ).toMatch(/20 bike-hours/);
  });
});

describe('review fixes', () => {
  const t = timingOf([line('hyd-madhapur', '2027-09-30', 18, 10)], 7);

  it('after the ads deadline only staff can approve, and only with a reason', () => {
    const late = t.adsDueAt + 3600;
    expect(stepProblem('paid', 'ads-approved', late, t, 'brand')).toMatch(/only RECALL staff/);
    expect(stepProblem('paid', 'ads-approved', late, t, 'admin')).toMatch(/reason/);
    expect(
      stepProblem('paid', 'ads-approved', late, t, 'admin', 'Festival offer, brand sent late'),
    ).toBeUndefined();
    expect(stepProblem('paid', 'ads-approved', t.adsDueAt - 1, t, 'brand')).toBeUndefined();
  });

  it('a payment that arrives after the start is still recorded', () => {
    expect(
      stepProblem('awaiting-payment', 'paid', t.firstHourAt + 60, t, 'system'),
    ).toBeUndefined();
  });

  it('a deal: total hours spread about equally over the months; the discount goes on the bill', () => {
    const months = [
      '2027-10-05',
      '2027-11-05',
      '2027-12-05',
      '2028-01-05',
      '2028-02-05',
      '2028-03-05',
    ];
    const oneDay = [line('hyd-madhapur', '2027-10-05', 18, 60)];
    expect(problems(() => quote(req(oneDay, { repeatMonths: 12 }), BOOK, AREAS, NOW))).toEqual([
      'repeat-not-spread',
    ]);
    // 20 Peak + 10 Lite bike-hours each month: Lite is not discounted.
    const even = months.flatMap((d) => [
      line('hyd-madhapur', d, 18, 20),
      line('hyd-madhapur', d, 23, 10),
    ]);
    const q = quote(req(even, { repeatMonths: 6 }), BOOK, AREAS, NOW);
    expect(q.listSubtotal).toBe(6 * (20 * 30_000 + 10 * 22_000));
    expect(q.discount).toBe(6 * 20 * 30_000 * 0.08);
    expect(q.subtotal).toBe(q.listSubtotal - q.discount);
    expect(q.gst).toBe(Math.round(q.subtotal * 0.18));
    expect(q.lines[0]?.paisePerBikeHour).toBe(30_000);
    // One month with far more than its share (more than 20% over) is refused.
    const lumpy = [...even, line('hyd-madhapur', '2027-10-06', 18, 20)];
    expect(problems(() => quote(req(lumpy, { repeatMonths: 6 }), BOOK, AREAS, NOW))).toEqual([
      'repeat-not-spread',
    ]);
    // Hours outside the 6 months are refused too.
    const late = [...even, line('hyd-madhapur', '2028-04-05', 18, 5)];
    expect(problems(() => quote(req(late, { repeatMonths: 6 }), BOOK, AREAS, NOW))).toEqual([
      'repeat-not-spread',
    ]);
  });

  it("a deal's months count from its first day, not from the calendar month (25 Jan start)", () => {
    const starts = [
      '2028-01-25',
      '2028-02-25',
      '2028-03-25',
      '2028-04-25',
      '2028-05-25',
      '2028-06-25',
    ];
    const even = starts.map((d) => line('hyd-madhapur', d, 18, 20));
    expect(quote(req(even, { repeatMonths: 6 }), BOOK, AREAS, NOW).discount).toBe(
      6 * 20 * 30_000 * 0.08,
    );
    // The last week (to 24 Jul) is still inside the 6 months; 25 Jul is not.
    const lastWeek = [...even.slice(0, 5), line('hyd-madhapur', '2028-07-20', 18, 20)];
    expect(quote(req(lastWeek, { repeatMonths: 6 }), BOOK, AREAS, NOW).bikeHours).toBe(120);
    const after = [...even.slice(0, 5), line('hyd-madhapur', '2028-07-25', 18, 20)];
    expect(problems(() => quote(req(after, { repeatMonths: 6 }), BOOK, AREAS, NOW))).toEqual([
      'repeat-not-spread',
    ]);
  });

  it('a deal offer may not take a discounted band below the ₹220 floor', () => {
    expect(checkPriceBook({ ...BOOK, repeatOffersBp: { 6: 800, 12: 1500 } })).toEqual([
      '12-month offer takes Normal below the floor',
    ]);
    // ₹250 less 12% is exactly ₹220: allowed.
    expect(checkPriceBook(BOOK)).toEqual([]);
  });

  it('each line is checked against the area as it stands on that day', () => {
    const off = {
      ...(AREAS.find((a) => a.areaId === 'hyd-madhapur') as (typeof AREAS)[number]),
      version: 2,
      active: false,
      validFrom: '2027-10-01T00:00:00.000Z',
    };
    const lines = [
      line('hyd-madhapur', '2027-09-20', 18, 60),
      line('hyd-madhapur', '2027-10-05', 18, 60),
    ];
    expect(problems(() => quote(req(lines), BOOK, [...AREAS, off], NOW))).toEqual(['area']);
    expect(
      quote(req([lines[0] as BookingLine]), BOOK, [...AREAS, off], NOW).lines[0]?.areaVersion,
    ).toBe(1);
  });

  it('a silly number of bikes is a clear refusal', () => {
    expect(
      problems(() =>
        quote(req([line('hyd-madhapur', '2027-09-30', 18, 11_000_000)]), BOOK, AREAS, NOW),
      ),
    ).toEqual(['bad-line']);
  });

  it('a trial needs a real mobile number; a GST number with spaces is the same number', () => {
    const wk = [line('hyd-gachibowli', '2027-09-01', 18, 5)];
    expect(trialProblem(wk, { phone: '' }, new Set(), BOOK)).toMatch(/valid mobile/);
    expect(trialProblem(wk, { phone: 'n/a' }, new Set(), BOOK)).toMatch(/valid mobile/);
    expect(trialProblem(wk, { phone: '09849011111' }, new Set(['phone:9849011111']), BOOK)).toMatch(
      /already/,
    );
    expect(
      trialProblem(
        wk,
        { phone: '9000000000', gstin: '36 aaaaa0000a1z5' },
        new Set(['gstin:36AAAAA0000A1Z5']),
        BOOK,
      ),
    ).toMatch(/already/);
  });
});
