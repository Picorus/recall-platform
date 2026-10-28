import {
  codeFromTyped,
  groupMobile as domainGroup,
  regroupMobile as domainRegroup,
} from '@recall/domain';
import { describe, expect, it } from 'vitest';
import {
  backTo,
  codeAsTyped,
  groupMobile,
  looksLikeCode,
  looksLikeEmail,
  looksLikeMobile,
  regroupMobile,
  timeLeft,
} from '../../lib/sign-in';

describe('brand sign-in page checks (P5.1)', () => {
  it('a mobile number as people type it', () => {
    for (const ok of ['98480 12345', '+91 98480 12345', '098480-12345', '6000000000'])
      expect(looksLikeMobile(ok)).toBe(true);
    for (const bad of ['', '12345', '58480 12345', '98480 123456', 'media@x.in'])
      expect(looksLikeMobile(bad)).toBe(false);
  });

  it('a mobile number shows grouped as typed, as @recall/domain groups it', () => {
    expect(groupMobile('9848012345')).toBe('98480 12345');
    expect(groupMobile('+91 9848012345')).toBe('+91 98480 12345');
    expect(looksLikeMobile(groupMobile('9848012345'))).toBe(true);
    for (const t of [
      '',
      '98',
      '98480',
      '984801',
      ' 98480-12345 ',
      '+9',
      '+91',
      '+91 98480 1',
      '0091 9848012345',
      '09848012345',
      '919848012345',
      '98480123456',
      'ab 12',
    ])
      expect(groupMobile(t), t).toBe(domainGroup(t));
  });

  it('an email address and a 6-digit code', () => {
    expect(looksLikeEmail(' Media@Adwise.in ')).toBe(true);
    expect(looksLikeEmail('media@adwise')).toBe(false);
    expect(looksLikeEmail(' media @ adwise .in ')).toBe(true);
    expect(looksLikeEmail('media team@adwise.in')).toBe(false);
    expect(looksLikeCode('123 456')).toBe(true);
    expect(looksLikeCode('12345')).toBe(false);
    // The code box keeps the digits of a pasted "123 456" or an autofilled "123456 ".
    expect(codeAsTyped(' 123 456 ')).toBe('123456');
    expect(codeAsTyped('123456 ')).toBe('123456');
    expect(codeAsTyped('1234567')).toBe('123456');
    for (const t of ['482 915', 'Valid 10 min: 482915', '48', '1234567', ' 123-456 ', 'ab'])
      expect(codeAsTyped(t), t).toBe(codeFromTyped(t));
    for (const [t, was] of [
      ['9848012345', '98480 12345'],
      ['98480 1234', '98480 12345'],
      ['+91 9848012345', '+91 98480 12345'],
    ] as const)
      expect(regroupMobile(t, was), t).toBe(domainRegroup(t, was));
  });

  it('time left on a code', () => {
    expect(timeLeft(245)).toBe('4:05');
    expect(timeLeft(-3)).toBe('0:00');
  });
});

describe('back to the page asked for after signing in (P5.7)', () => {
  it('a page of this site, as asked', () => {
    expect(backTo('/campaigns/BK-1234/report')).toBe('/campaigns/BK-1234/report');
    expect(backTo('/ads?brand=BR-1&booking=BK-2')).toBe('/ads?brand=BR-1&booking=BK-2');
  });
  it('never another site, nothing odd', () => {
    for (const bad of [
      null,
      '',
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '/a b',
      '/<x>',
    ])
      expect(backTo(bad)).toBe('/');
  });
});
