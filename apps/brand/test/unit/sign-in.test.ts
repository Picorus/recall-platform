import { describe, expect, it } from 'vitest';
import {
  backTo,
  looksLikeCode,
  looksLikeEmail,
  looksLikeMobile,
  timeLeft,
} from '../../lib/sign-in';

describe('brand sign-in page checks (P5.1)', () => {
  it('a mobile number as people type it', () => {
    for (const ok of ['98480 12345', '+91 98480 12345', '098480-12345', '6000000000'])
      expect(looksLikeMobile(ok)).toBe(true);
    for (const bad of ['', '12345', '58480 12345', '98480 123456', 'media@x.in'])
      expect(looksLikeMobile(bad)).toBe(false);
  });

  it('an email address and a 6-digit code', () => {
    expect(looksLikeEmail(' Media@Adwise.in ')).toBe(true);
    expect(looksLikeEmail('media@adwise')).toBe(false);
    expect(looksLikeCode('123 456')).toBe(true);
    expect(looksLikeCode('12345')).toBe(false);
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
