import { describe, expect, it } from 'vitest';
import { linesOf, linkText } from '../../lib/bookings';

describe('booking for a brand (P3.8.2)', () => {
  it('lines: every day × hour, across a month end; says what is missing', () => {
    expect(linesOf('hyd-madhapur', '2027-08-31', '2027-09-01', [20, 19], 10)).toEqual({
      lines: [
        { areaId: 'hyd-madhapur', date: '2027-08-31', startHour: 19, bikes: 10 },
        { areaId: 'hyd-madhapur', date: '2027-08-31', startHour: 20, bikes: 10 },
        { areaId: 'hyd-madhapur', date: '2027-09-01', startHour: 19, bikes: 10 },
        { areaId: 'hyd-madhapur', date: '2027-09-01', startHour: 20, bikes: 10 },
      ],
    });
    expect(linesOf('', '2027-08-31', '2027-08-31', [19], 10)).toEqual({
      problem: 'Choose an area',
    });
    expect(linesOf('a', '2027-09-02', '2027-09-01', [19], 10)).toEqual({
      problem: 'The last day is before the first',
    });
    expect(linesOf('a', '2027-09-01', '2027-09-01', [], 10)).toEqual({
      problem: 'Choose at least one start hour',
    });
    expect(linesOf('a', '2027-09-01', '2027-09-01', [19], 0)).toEqual({
      problem: 'Bikes must be a whole number',
    });
    const hours = Array.from({ length: 18 }, (_, i) => i + 8);
    expect(linesOf('a', '2027-09-01', '2027-10-31', hours, 5)).toEqual({
      problem: 'At most 500 area-hours in one booking',
    });
  });

  it('a payment link in words', () => {
    expect(linkText(null, 0)).toBe('No payment link yet');
    expect(linkText({ expiresAt: 100, states: [] }, 50)).toBe('Waiting for payment');
    expect(linkText({ expiresAt: 100, states: [] }, 100)).toBe('Link ran out unpaid');
    expect(linkText({ expiresAt: 100, states: ['paid'] }, 200)).toBe('Paid');
    expect(linkText({ expiresAt: 100, states: ['expired', 'paid-late'] }, 200)).toBe(
      'Paid after cancelling: finance to return it',
    );
  });
});
