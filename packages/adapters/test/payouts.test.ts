import { describe, expect, it } from 'vitest';
import { fakePayouts, type PayoutRequest } from '../src/payouts.js';

const req = (riderId: string, amountPaise = 10_000): PayoutRequest => ({
  payoutKey: `2027-08-09:${riderId}`,
  riderId,
  amountPaise,
  to: { kind: 'upi', vpa: `${riderId}@upi`, name: riderId },
});

describe('the fake payout provider', () => {
  it('pays, and a repeat with the same key gets the same answer (never paid twice)', async () => {
    const p = fakePayouts();
    const a = await p.send(req('R-A'));
    expect(a.status).toBe('paid');
    expect(await p.send(req('R-A', 99_999))).toEqual(a);
  });

  it('fails where told: a passing failure clears after the given tries', async () => {
    const p = fakePayouts({
      failFor: new Map([
        ['R-B', { reason: 'bank down', retryable: true, times: 1 }],
        ['R-C', { reason: 'wrong IFSC', retryable: false }],
      ]),
    });
    expect(await p.send(req('R-B'))).toMatchObject({ status: 'failed', retryable: true });
    expect((await p.send(req('R-B'))).status).toBe('paid');
    expect(await p.send(req('R-C'))).toMatchObject({ status: 'failed', retryable: false });
  });

  it('a pending payout settles when asked again', async () => {
    const p = fakePayouts({ pendingFor: new Set(['R-D']) });
    expect((await p.send(req('R-D'))).status).toBe('pending');
    expect((await p.send(req('R-D'))).status).toBe('paid');
  });
});
