import { describe, expect, it } from 'vitest';
import { brandCodeEmail, brandCodeSms, emailAddress } from '../src/brand-sign-in.js';

describe('brand sign-in (P5.1)', () => {
  it('reads an email address as typed', () => {
    expect(emailAddress(' Media@Agency.IN ')).toBe('media@agency.in');
    expect(emailAddress('a.b+c@x.co')).toBe('a.b+c@x.co');
    // Stray spaces next to "@" and "." (a phone keyboard adds them) are dropped.
    expect(emailAddress('  ravi @ gmail .com\t')).toBe('ravi@gmail.com');
    for (const bad of ['', 'media', 'media@', '@agency.in', 'a b@x.in', 'a@b', 'a@@b.in'])
      expect(emailAddress(bad)).toBeNull();
    expect(emailAddress(`${'a'.repeat(65)}@x.in`)).toBeNull();
  });

  it('puts the code and how long it works in each message', () => {
    const e = brandCodeEmail('123456', 10);
    expect(e.subject).toBe('123456 is your RECALL sign-in code');
    expect(e.text).toContain('10 minutes');
    expect(e.html).toContain('123456');
    expect(brandCodeSms('654321', 5)).toBe(
      '654321 is your RECALL sign-in code. It works for 5 minutes. Do not share it.',
    );
  });
});
