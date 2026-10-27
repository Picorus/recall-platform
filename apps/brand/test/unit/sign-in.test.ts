import { describe, expect, it } from 'vitest';
import { looksLikeCode, looksLikeEmail, looksLikeMobile, timeLeft } from '../../lib/sign-in';

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
