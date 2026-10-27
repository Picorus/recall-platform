// P4.4: what the Today page says a rider earned, by the same rules as his pay.
import { describe, expect, it } from 'vitest';
import {
  daysBetween,
  dayEarnings,
  DEFAULT_RIDER_PAY_RULES as PAY,
  hourlyPaise,
  pocDayPaise,
  riderPay,
  signalBars,
} from '../src/index.js';

describe('rider Today (P4.4)', () => {
  it('a regular day: ₹25 an hour, the same paise as the pay run', () => {
    for (const seconds of [0, 1, 59, 1800, 3599, 3600, 37 * 3600 + 17]) {
      const run = riderPay(PAY, undefined, {
        countedSeconds: seconds,
        paidSeconds: seconds,
        soldPaise: 0,
        pocDays: [],
        daysInMonth: 31,
      });
      expect(hourlyPaise(PAY, seconds)).toBe(run.hourly);
      expect(
        dayEarnings(PAY, undefined, {
          day: '2027-07-20',
          countedSeconds: seconds,
          held: true,
          mode: 'regular',
        }),
      ).toBe(run.hourly);
    }
  });

  it("a POC day: the month's base for that day when he held a screen; none before the POC", () => {
    const d = { day: '2027-09-10', countedSeconds: 5000, held: true, mode: 'poc' } as const;
    // September is POC month 2 when it started in August: ₹4,000 over 30 days.
    expect(dayEarnings(PAY, '2027-08', d)).toBe(pocDayPaise(400_000, 30, 10));
    expect(dayEarnings(PAY, '2027-08', { ...d, held: false })).toBe(0);
    expect(dayEarnings(PAY, '2027-10', d)).toBe(0);
    // The days of a month add up to its base exactly.
    const all = daysBetween('2027-08-01', '2027-08-31').map((day) =>
      dayEarnings(PAY, '2027-08', { ...d, day }),
    );
    expect(all.reduce((a, b) => a + b, 0)).toBe(200_000);
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
    expect(daysBetween('2027-07-19', '2027-07-19')).toEqual(['2027-07-19']);
  });
});
