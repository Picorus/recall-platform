// P3.8.2: the fake payments provider behaves like a real one where it matters: one link per key,
// links expire, only correctly signed messages are trusted.
import { describe, expect, it } from 'vitest';
import { fakePayments } from '../src/payments.js';

const T = 1_800_000_000;
const req = {
  linkKey: 'BK-1#2124000',
  bookingId: 'BK-1',
  amountPaise: 2_124_000,
  description: 'RECALL booking BK-1',
  expiresAt: T + 3600,
};

describe('fake payments (P3.8.2)', () => {
  it('one link per key; paid by the brand; the signed message is trusted, a forged one is not', async () => {
    let now = T;
    const p = fakePayments({ clock: () => now });
    const a = await p.createLink(req);
    expect(await p.createLink(req)).toEqual(a);
    expect(a.url).toMatch(/^https:\/\/pay\.fake\.recall\.example\/l\/plink_/);
    expect(await p.status(a.linkId)).toEqual({ state: 'created' });
    now += 60;
    const msg = p.pay(a.linkId);
    expect(p.verifyEvent(msg.body, msg.signature)).toEqual({
      linkId: a.linkId,
      status: {
        state: 'paid',
        paymentId: expect.stringMatching(/^pay_fake_/),
        paidAt: T + 60,
        amountPaise: 2_124_000,
      },
    });
    expect(p.verifyEvent(msg.body.replace('paid', 'paid '), msg.signature)).toBeNull();
    expect(p.verifyEvent(msg.body, 'nope')).toBeNull();
    expect(p.verifyEvent('not json', p.sign('not json'))).toBeNull();
    expect(() => p.pay(a.linkId)).toThrow('cannot be paid');
  });

  it('a link expires unpaid; a cancelled link cannot be paid; amounts are whole paise above 0', async () => {
    let now = T;
    const p = fakePayments({ clock: () => now });
    const a = await p.createLink(req);
    now = T + 3600;
    expect(await p.status(a.linkId)).toEqual({ state: 'expired' });
    const b = await p.createLink({ ...req, linkKey: 'other', expiresAt: T + 99_999 });
    await p.cancelLink(b.linkId);
    await p.cancelLink(b.linkId);
    expect(await p.status(b.linkId)).toEqual({ state: 'cancelled' });
    expect(() => p.pay(b.linkId)).toThrow();
    await expect(p.createLink({ ...req, linkKey: 'x', amountPaise: 10.5 })).rejects.toThrow(
      RangeError,
    );
  });
});
