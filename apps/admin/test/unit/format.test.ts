import {
  codeFromTyped,
  formatRupees,
  groupMobile as domainGroup,
  paise,
  regroupMobile as domainRegroup,
} from '@recall/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clock,
  count,
  dayName,
  groupMobile,
  noSpaces,
  regroupMobile,
  rupees,
  since,
  sixDigits,
} from '../../lib/format';

describe('how the admin site writes things', () => {
  it('rupees with Indian grouping, from paise', () => {
    expect(rupees(0)).toBe('₹0');
    expect(rupees(22_550)).toBe('₹225.50');
    expect(rupees(13_500_000)).toBe('₹1,35,000');
    expect(rupees(13_500_093_450)).toBe('₹13,50,00,934.50');
    expect(count(15_500)).toBe('15,500');
    expect(count(100_000)).toBe('1,00,000');
  });

  it('matches the money rules in the domain for any amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 13 }), (p) => {
        const want = formatRupees(paise(p)).replace(/\.00$/, '');
        expect(rupees(p)).toBe(want);
      }),
    );
  });

  it('India time and days', () => {
    expect(clock(Date.UTC(2027, 7, 23, 13, 0) / 1000)).toBe('18:30');
    expect(dayName('2027-08-23')).toBe('Mon 23 Aug');
    expect(since(0, 240)).toBe('4 min');
    expect(since(0, 7500)).toBe('2 h 5 min');
    expect(since(0, 7200)).toBe('2 h');
    expect(since(0, 3 * 86_400)).toBe('3 days');
  });
});

describe('boxes for codes and ids', () => {
  it('drops spaces anywhere; a code keeps its 6 digits', () => {
    expect(noSpaces(' SBIN 0001234\t')).toBe('SBIN0001234');
    expect(noSpaces('chai-co')).toBe('chai-co');
    expect(sixDigits(' 123 456 ')).toBe('123456');
    expect(sixDigits('123-456')).toBe('123456');
    expect(sixDigits('1234567')).toBe('123456');
    for (const t of ['482 915', 'Valid 10 min: 482915', '48', '1234567', ' 123-456 ', 'ab'])
      expect(sixDigits(t), t).toBe(codeFromTyped(t));
    for (const [t, was] of [
      ['9848012345', '98480 12345'],
      ['98480 1234', '98480 12345'],
      ['+91 9848012345', '+91 98480 12345'],
      ['9848', ''],
    ] as const)
      expect(regroupMobile(t, was), t).toBe(domainRegroup(t, was));
    expect(sixDigits('12a')).toBe('12');
  });

  it('a mobile number shows grouped, as @recall/domain groups it', () => {
    expect(groupMobile('9848000001')).toBe('98480 00001');
    expect(groupMobile('+919848000001')).toBe('+91 98480 00001');
    fc.assert(fc.property(fc.string(), (t) => groupMobile(t) === domainGroup(t)));
  });
});
