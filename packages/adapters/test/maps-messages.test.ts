import { describe, expect, it } from 'vitest';
import { fakeMaps } from '../src/maps.js';
import { fakeMessages } from '../src/messages.js';

describe('fake maps and messages (P1.9)', () => {
  it('names the nearest main road within 1.2 km, nothing farther', async () => {
    const maps = fakeMaps();
    expect(await maps.streetAt(17.448, 78.3915)).toBe('Madhapur Main Road');
    expect(await maps.streetAt(17.6, 78.6)).toBeUndefined();
    expect(maps.calls()).toBe(2);
  });

  it('a message key is sent once; a passing failure can succeed later', async () => {
    const failFor = new Map([['a@b.in', { reason: 'down', retryable: true }]]);
    const m = fakeMessages({ failFor });
    const mail = {
      channel: 'email' as const,
      key: 'k1',
      to: 'a@b.in',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      attachments: [],
    };
    expect((await m.send(mail)).status).toBe('failed');
    failFor.clear();
    expect((await m.send(mail)).status).toBe('sent');
    expect(await m.send(mail)).toEqual({ status: 'sent', providerRef: 'fake-email-1' });
    expect(m.sent).toHaveLength(1);
  });
});
