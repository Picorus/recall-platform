// Brand payments in the API's settings (review P3.8.2): the fake only on a laptop, never with the
// public key on a server others can reach; production without a real provider runs without payments.
import { describe, expect, it } from 'vitest';
import { paymentsFrom, riderChecksFrom } from '../../src/config.js';

describe('payments settings (P3.8.2)', () => {
  it('a laptop gets the fake; a reachable server needs its own key; production never the fake', () => {
    expect(paymentsFrom({}, false)).toBeDefined();
    expect(() => paymentsFrom({ API_HOST: '0.0.0.0' }, false)).toThrow('PAYMENTS_WEBHOOK_SECRET');
    expect(
      paymentsFrom({ API_HOST: '0.0.0.0', PAYMENTS_WEBHOOK_SECRET: 'x'.repeat(32) }, false),
    ).toBeDefined();
    // Bound to this machine but behind a proxy, or serving a reachable admin site: still outside.
    expect(() => paymentsFrom({ API_PROXY_HOPS: '1' }, false)).toThrow('PAYMENTS_WEBHOOK_SECRET');
    expect(() => paymentsFrom({ ADMIN_ORIGINS: 'https://staging.recall.in' }, false)).toThrow(
      'PAYMENTS_WEBHOOK_SECRET',
    );
    expect(paymentsFrom({}, true)).toBeUndefined();
    expect(() => paymentsFrom({ PAYMENTS_PROVIDER: 'fake' }, true)).toThrow('laptop only');
    expect(() => paymentsFrom({ PAYMENTS_PROVIDER: 'razorpay' }, false)).toThrow('P6');
  });

  it('rider checks: the fakes only on a laptop nobody else can reach; none in production (P3.11.2)', () => {
    expect(riderChecksFrom({}, false)).toBeDefined();
    expect(riderChecksFrom({}, true)).toBeUndefined();
    expect(() => riderChecksFrom({ API_HOST: '0.0.0.0' }, false)).toThrow('laptop only');
    expect(() => riderChecksFrom({ ADMIN_ORIGINS: 'https://staging.recall.in' }, false)).toThrow(
      'laptop only',
    );
    expect(() => riderChecksFrom({ RIDER_CHECKS_PROVIDER: 'fake' }, true)).toThrow('laptop only');
    expect(() => riderChecksFrom({ RIDER_CHECKS_PROVIDER: 'signzy' }, false)).toThrow('P4');
  });
});
