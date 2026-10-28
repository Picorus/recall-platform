// P7.7.7: a final report's plays by day and by hour, for the brand portal's charts.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { reportDays, reportHours } from '../src/report-trend.js';
import type { ReportLine } from '../src/report.js';

const line = (
  date: string,
  startHour: number,
  bikes: number,
  promised: number,
  delivered: number,
  madeUp = 0,
): ReportLine => ({
  lineId: `BK-1/hyd-madhapur/${date}/${startHour}`,
  areaId: 'hyd-madhapur',
  areaName: 'Madhapur',
  date,
  startHour,
  bikes,
  promised,
  delivered,
  madeUp,
  missing: Math.max(0, promised - delivered - madeUp),
});

describe('a report by day and by hour', () => {
  const lines = [
    line('2027-09-02', 19, 10, 400, 390, 10),
    line('2027-09-01', 25, 5, 200, 150), // 1am: still 1 Sep's business day
    line('2027-09-01', 19, 10, 400, 420), // extras beyond the promise are kept as delivered
    line('2027-09-02', 8, 5, 200, 0, 120),
  ];

  it('adds each day up, in date order, make-ups with their own day', () => {
    expect(reportDays({ lines })).toEqual([
      { date: '2027-09-01', bikeHours: 15, promised: 600, delivered: 570 },
      { date: '2027-09-02', bikeHours: 15, promised: 600, delivered: 520 },
    ]);
  });

  it('adds each hour up over the days, 8am first and 1am last', () => {
    expect(reportHours({ lines })).toEqual([
      { hour: 8, bikeHours: 5, promised: 200, delivered: 120 },
      { hour: 19, bikeHours: 20, promised: 800, delivered: 820 },
      { hour: 25, bikeHours: 5, promised: 200, delivered: 150 },
    ]);
  });

  it('no lines, nothing to show', () => {
    expect(reportDays({ lines: [] })).toEqual([]);
    expect(reportHours({ lines: [] })).toEqual([]);
  });

  it('never loses or makes up a play or a bike-hour', () => {
    const arb = fc.array(
      fc.record({
        date: fc.constantFrom('2027-09-01', '2027-09-02', '2027-09-03'),
        hour: fc.integer({ min: 8, max: 25 }),
        bikes: fc.integer({ min: 1, max: 100 }),
        promised: fc.integer({ min: 0, max: 5000 }),
        delivered: fc.integer({ min: 0, max: 5000 }),
        madeUp: fc.integer({ min: 0, max: 500 }),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, (xs) => {
        const ls = xs.map((x) => line(x.date, x.hour, x.bikes, x.promised, x.delivered, x.madeUp));
        const total = (
          rows: readonly { bikeHours: number; promised: number; delivered: number }[],
        ) =>
          rows.reduce(
            (n, r) => [n[0] + r.bikeHours, n[1] + r.promised, n[2] + r.delivered],
            [0, 0, 0],
          );
        const want = ls.reduce(
          (n, l) => [n[0] + l.bikes, n[1] + l.promised, n[2] + l.delivered + l.madeUp],
          [0, 0, 0],
        );
        expect(total(reportDays({ lines: ls }))).toEqual(want);
        expect(total(reportHours({ lines: ls }))).toEqual(want);
      }),
    );
  });
});
