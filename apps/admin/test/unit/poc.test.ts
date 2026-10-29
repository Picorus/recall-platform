// P7.8: the staff POC page's month choices: a brand starts in a month not yet started, inside the
// POC's planned months, and commits for 1 to its most without going past the planned end.
import { describe, expect, it } from 'vitest';
import { commitmentMonths, monthShort, nextMonth, startMonths } from '../../lib/poc';
import type { PocPhase } from '../../lib/settings';

const ist = (iso: string) => Date.parse(`${iso}+05:30`) / 1000;
const scheduled: PocPhase = {
  phase: 'scheduled',
  startsAt: ist('2027-08-01T08:00:00'),
  plannedEnd: ist('2027-11-01T08:00:00'),
  endedAt: null,
};

describe('POC months', () => {
  it('a brand starts from the first month not started, inside the planned months', () => {
    expect(startMonths('2027-08', scheduled)).toEqual(['2027-08', '2027-09', '2027-10']);
    // Switched on mid-July: July is not part of the POC.
    expect(startMonths('2027-07', scheduled)).toEqual(['2027-08', '2027-09', '2027-10']);
    expect(startMonths('2027-10', { ...scheduled, phase: 'running' })).toEqual(['2027-10']);
    expect(startMonths('2027-08', { phase: 'none' })).toEqual([]);
    expect(startMonths('2027-08', { ...scheduled, phase: 'ended', endedAt: 1 })).toEqual([]);
  });

  it('a commitment never goes past the planned end', () => {
    expect(commitmentMonths('2027-08', scheduled, 3)).toEqual([1, 2, 3]);
    expect(commitmentMonths('2027-09', scheduled, 3)).toEqual([1, 2]);
    expect(commitmentMonths('2027-08', scheduled, 1)).toEqual([1]);
  });

  it('months in words', () => {
    expect(monthShort('2027-08')).toBe('Aug 2027');
    expect(nextMonth('2027-12')).toBe('2028-01');
  });
});
