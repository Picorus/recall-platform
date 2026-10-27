import { describe, expect, it } from 'vitest';
import { dayText, daysText, rupees } from '../../lib/format';

describe('portal money and dates', () => {
  it('rupees with lakh grouping', () => {
    expect(rupees(0)).toBe('₹0');
    expect(rupees(1_500_000)).toBe('₹15,000');
    expect(rupees(12_345_678_90)).toBe('₹1,23,45,678.90');
    expect(rupees(-5000)).toBe('−₹50');
  });
  it('days', () => {
    expect(dayText('2027-09-10')).toBe('Fri 10 Sep 2027');
    expect(daysText('2027-09-10', '2027-09-10')).toBe('Fri 10 Sep 2027');
    expect(daysText('2027-09-10', '2027-09-16')).toBe('10–16 Sep 2027');
    expect(daysText('2027-09-28', '2027-10-04')).toBe('28 Sep – 4 Oct 2027');
    expect(daysText('2027-12-28', '2028-01-04')).toBe('28 Dec 2027 – 4 Jan 2028');
  });
});
