// P3.15: messages coming in: only a correctly signed post with a sound message is trusted.
import { describe, expect, it } from 'vitest';
import { fakeInbound } from '../src/inbound.js';

describe('messages coming in (P3.15)', () => {
  it('trusts a signed, well-formed post only', () => {
    const inbound = fakeInbound();
    const m = {
      channel: 'whatsapp' as const,
      providerId: 'wamid.1',
      from: '+919848012345',
      text: 'Hello, my screen is off',
      at: 1_800_000_000,
    };
    const post = inbound.message(m);
    expect(inbound.verify(post.body, post.signature)).toEqual(m);
    expect(inbound.verify(post.body, 'f'.repeat(64))).toBeNull();
    expect(inbound.verify(`${post.body} `, post.signature)).toBeNull();
    const bad = inbound.message({ ...m, from: '98480 12345' });
    expect(inbound.verify(bad.body, bad.signature)).toBeNull();
    const mail = inbound.message({
      channel: 'email',
      providerId: 'mail-1',
      from: 'Chai@Example.in',
      subject: 'Invoice',
      text: 'Please send the invoice',
      at: 1_800_000_000,
    });
    expect(inbound.verify(mail.body, mail.signature)?.from).toBe('chai@example.in');
    // A NUL in the text, or a new line in a subject (it becomes an email header): refused.
    const nul = inbound.message({ ...m, text: 'a\u0000b' });
    expect(inbound.verify(nul.body, nul.signature)).toBeNull();
    const header = inbound.message({
      channel: 'email',
      providerId: 'mail-2',
      from: 'chai@example.in',
      subject: 'Hi\r\nBcc: x@y.in',
      text: 'x',
      at: 1_800_000_000,
    });
    expect(inbound.verify(header.body, header.signature)).toBeNull();
  });
});
