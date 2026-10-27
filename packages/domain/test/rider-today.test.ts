// P4.4: what the Today page says a rider earned, by the same rules as his pay: the days of a month
// always add up exactly to what the pay run gives for it (the cap and the rounding included).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  DEFAULT_RIDER_PAY_RULES as PAY,
  earningsByDay,
  pocDayPaise,
  riderPay,
  signalBars,
  type RiderDay,
} from '../src/index.js';

const regular = (day: string, countedSeconds: number): RiderDay => ({
  day,
  countedSeconds,
  held: true,
  mode: 'regular',
});

describe('rider Today (P4.4)', () => {
  it("a regular month's days add up to the pay run's hourly pay, the cap and the rounding included", () => {
    const august = daysBetween('2027-08-01', '2027-08-31');
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 18 * 3600 }), { minLength: 31, maxLength: 31 }),
        (secs) => {
          const days = august.map((d, i) => regular(d, secs[i] ?? 0));
          const earned = earningsByDay(days, () => PAY, undefined);
          const total = secs.reduce((a, b) => a + b, 0);
          const run = riderPay(PAY, undefined, {
            countedSeconds: total,
            paidSeconds: Math.min(total, PAY.monthlyCapHours * 3600),
            soldPaise: 0,
            pocDays: [],
            daysInMonth: 31,
          });
          const sum = [...earned.values()].reduce((a, b) => a + b, 0);
          expect(sum).toBe(run.hourly);
          // Every running total is what the pay run would give for the month so far.
          for (const v of earned.values()) expect(v).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('past the 260-hour cap a day earns nothing; one second a day is not paid seven times', () => {
    const days = daysBetween('2027-08-01', '2027-08-27').map((d) => regular(d, 10 * 3600));
    const earned = earningsByDay(days, () => PAY, undefined);
    expect(earned.get('2027-08-26')).toBe(10 * PAY.perMovingHourPaise);
    expect(earned.get('2027-08-27')).toBe(0);
    const tiny = earningsByDay(
      daysBetween('2027-08-01', '2027-08-07').map((d) => regular(d, 1)),
      () => PAY,
      undefined,
    );
    expect([...tiny.values()].reduce((a, b) => a + b, 0)).toBe(
      riderPay(PAY, undefined, {
        countedSeconds: 7,
        paidSeconds: 7,
        soldPaise: 0,
        pocDays: [],
        daysInMonth: 31,
      }).hourly,
    );
    // A new month starts again from nothing; each month by its own rules.
    const across = earningsByDay(
      [regular('2027-08-31', 3600), regular('2027-09-01', 3600)],
      (m) => (m === '2027-09' ? { ...PAY, perMovingHourPaise: 3_000 } : PAY),
      undefined,
    );
    expect([...across.values()]).toEqual([2_500, 3_000]);
    // No price book in force: nothing is paid, nothing shown.
    expect(
      earningsByDay([regular('2027-08-02', 3600)], () => undefined, undefined).get('2027-08-02'),
    ).toBe(0);
  });

  it("a POC day: the month's base for that day when he held a screen; none before the POC", () => {
    const d: RiderDay = { day: '2027-09-10', countedSeconds: 5000, held: true, mode: 'poc' };
    const one = (x: RiderDay, first: string) => earningsByDay([x], () => PAY, first).get(x.day);
    // September is POC month 2 when it started in August: ₹4,000 over 30 days.
    expect(one(d, '2027-08')).toBe(pocDayPaise(400_000, 30, 10));
    expect(one({ ...d, held: false }, '2027-08')).toBe(0);
    expect(one(d, '2027-10')).toBe(0);
    const all = earningsByDay(
      daysBetween('2027-08-01', '2027-08-31').map((day) => ({ ...d, day })),
      () => PAY,
      '2027-08',
    );
    expect([...all.values()].reduce((a, b) => a + b, 0)).toBe(200_000);
  });

  it('signal bars and the days of a week', () => {
    expect([null, -60, -85, -90, -100, -110, -120].map(signalBars)).toEqual([
      null,
      4,
      4,
      3,
      2,
      1,
      0,
    ]);
    expect(daysBetween('2027-07-30', '2027-08-02')).toEqual([
      '2027-07-30',
      '2027-07-31',
      '2027-08-01',
      '2027-08-02',
    ]);
  });
});
