// Numbers and codes as people type them: grouped to read in the box, read back the same.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  codeFromTyped,
  groupMobile,
  indiaMobile,
  regroupMobile,
  typedCode,
} from '../src/rider-sign-in.js';

describe('a mobile number in the box', () => {
  it('groups as typed: 5 and 5, with +91 or 0 kept in front', () => {
    expect(groupMobile('')).toBe('');
    expect(groupMobile('9848')).toBe('9848');
    expect(groupMobile('98480')).toBe('98480');
    expect(groupMobile('984800')).toBe('98480 0');
    expect(groupMobile('9848000001')).toBe('98480 00001');
    expect(groupMobile(' 98 480-000 01 ')).toBe('98480 00001');
    expect(groupMobile('+91')).toBe('+91');
    expect(groupMobile('+91 9848000001')).toBe('+91 98480 00001');
    expect(groupMobile('+919848000001')).toBe('+91 98480 00001');
    expect(groupMobile('09848000001')).toBe('0 98480 00001');
    expect(groupMobile('919848000001')).toBe('91 98480 00001');
    // Deleting the space after "98480" leaves no space to delete again.
    expect(groupMobile('98480 ')).toBe('98480');
  });

  it('never changes the number that is read from it', () => {
    const typed = fc.stringMatching(/^\+?[0-9 ()-]{0,16}$/);
    fc.assert(
      fc.property(typed, (t) => {
        const g = groupMobile(t);
        expect(groupMobile(g)).toBe(g);
        expect(indiaMobile(g)).toBe(indiaMobile(t));
      }),
    );
    expect(indiaMobile(groupMobile('9848000001'))).toBe('+919848000001');
  });

  it('a code with stray spaces', () => {
    expect(typedCode(' 123 456 ')).toBe('123456');
    expect(typedCode('12345')).toBeNull();
  });
});

describe('editing the boxes', () => {
  it('a backspace just after the space takes the digit before it', () => {
    expect(regroupMobile('9848012345', '98480 12345')).toBe('98481 2345');
    expect(regroupMobile('98480 1234', '98480 12345')).toBe('98480 1234');
    expect(regroupMobile('98480 123456', '98480 12345')).toBe('98480 123456');
    expect(regroupMobile('9848000001')).toBe('98480 00001');
    expect(regroupMobile('+91 9848012345', '+91 98480 12345')).toBe('+91 98481 2345');
  });

  it('the code from a typed, spaced or pasted text', () => {
    expect(codeFromTyped('482 915')).toBe('482915');
    expect(codeFromTyped(' 482915 ')).toBe('482915');
    expect(codeFromTyped('482-915')).toBe('482915');
    expect(codeFromTyped('Valid 10 min: 482915')).toBe('482915');
    expect(codeFromTyped('482915 is your RECALL code. It works for 10 minutes.')).toBe('482915');
    expect(codeFromTyped('48')).toBe('48');
    expect(codeFromTyped('1234567')).toBe('123456');
  });
});
