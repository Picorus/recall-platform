// Brand payments in the API's settings (review P3.8.2): the fake only on a laptop, never with the
// public key on a server others can reach; production without a real provider runs without payments.
import { describe, expect, it } from 'vitest';
import {
  inboundFrom,
  paymentsFrom,
  readConfig,
  payoutsFrom,
  reportsFrom,
  riderChecksFrom,
} from '../../src/config.js';

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

  it('payouts: the fake only on a laptop nobody else can reach; none in production (P3.12)', () => {
    expect(payoutsFrom({}, false)).toBeDefined();
    expect(payoutsFrom({}, true)).toBeUndefined();
    expect(() => payoutsFrom({ API_PROXY_HOPS: '1' }, false)).toThrow('laptop only');
    expect(() => payoutsFrom({ PAYOUTS_PROVIDER: 'fake' }, true)).toThrow('laptop only');
    expect(() => payoutsFrom({ PAYOUTS_PROVIDER: 'razorpayx' }, false)).toThrow('P6');
  });

  it('reports: the fake maps and messages only on a laptop; none in production (P3.14.1)', () => {
    expect(reportsFrom({}, false)?.portalUrl).toBe('http://localhost:3000');
    expect(reportsFrom({ BRAND_PORTAL_URL: 'http://localhost:3000/' }, false)?.portalUrl).toBe(
      'http://localhost:3000',
    );
    expect(reportsFrom({}, true)).toBeUndefined();
    expect(() => reportsFrom({ API_HOST: '0.0.0.0' }, false)).toThrow('laptop only');
    expect(() => reportsFrom({ REPORTS_PROVIDER: 'fake' }, true)).toThrow('laptop only');
    expect(() => reportsFrom({ REPORTS_PROVIDER: 'gupshup' }, false)).toThrow('P6');
  });

  it('messages coming in: the fake only on a laptop; none in production (P3.15)', () => {
    expect(inboundFrom({}, false)).toBeDefined();
    expect(inboundFrom({}, true)).toBeUndefined();
    expect(() => inboundFrom({ API_HOST: '0.0.0.0' }, false)).toThrow('laptop only');
    expect(() => inboundFrom({ SUPPORT_INBOUND_PROVIDER: 'fake' }, true)).toThrow('laptop only');
    expect(() => inboundFrom({ SUPPORT_INBOUND_PROVIDER: 'gupshup' }, false)).toThrow('P6');
  });
});

describe('outside services for the Settings page (P3.17)', () => {
  it('a laptop lists every service as a stand-in, with no key shown', () => {
    const cfg = readConfig({
      DATABASE_URL: 'postgres://x',
      PAYMENTS_WEBHOOK_SECRET: 's'.repeat(40),
    });
    expect(cfg.connections?.map((c) => c.service)).toEqual([
      'Brand payments',
      'Rider checks (KYC, e-sign, bank)',
      'Rider payouts',
      'Maps, WhatsApp and email out',
      'Messages coming in',
      'Ad file store',
    ]);
    expect(cfg.connections?.every((c) => c.state === 'stand-in' && c.provider === 'fake')).toBe(
      true,
    );
    expect(JSON.stringify(cfg.connections)).not.toContain('s'.repeat(40));
  });
});
