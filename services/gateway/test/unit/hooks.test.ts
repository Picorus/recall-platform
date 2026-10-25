import { describe, expect, it } from 'vitest';
import { renderEmqxConfig } from '../../src/emqx-config.js';
import { authz, gatewayTopicAllowed, sameSecret, type HookConfig } from '../../src/hooks.js';

const CFG: HookConfig = { token: 't0ken', gatewayUser: 'recall-gateway', gatewayPassword: 'pw' };
const ME = 'SCR-0123456Z';
const gw = { clientid: 'recall-gateway-ab12', username: 'recall-gateway' };

describe('gateway hooks (P2.3.2): who may use which topic', () => {
  it('a screen: only its own topics, whatever it calls itself', () => {
    const asks = (topic: string, action: string, clientid = ME, username = 'f'.repeat(32)) =>
      authz(CFG, { clientid, username, topic, action });
    expect(asks(`recall/v1/s/${ME}/up/upload`, 'publish')).toBe(true);
    expect(asks(`recall/v1/s/${ME}/down/#`, 'subscribe')).toBe(true);
    expect(asks('recall/v1/s/SCR-00000000/up/upload', 'publish')).toBe(false);
    expect(asks('recall/v1/s/+/up/+', 'subscribe')).toBe(false);
    expect(asks('$share/gateway/recall/v1/s/+/up/+', 'subscribe')).toBe(false);
    expect(asks(`recall/v1/s/${ME}/up/upload`, 'all')).toBe(false);
    // A screen naming itself the gateway (its user name is its certificate's fingerprint).
    expect(asks('recall/v1/s/+/up/+', 'subscribe', 'recall-gateway-x')).toBe(false);
  });

  it('the gateway: every up topic to read, any screen down topic to write, nothing else', () => {
    expect(
      authz(CFG, { ...gw, topic: '$share/gateway/recall/v1/s/+/up/+', action: 'subscribe' }),
    ).toBe(true);
    expect(authz(CFG, { ...gw, topic: `recall/v1/s/${ME}/down/ack`, action: 'publish' })).toBe(
      true,
    );
    expect(gatewayTopicAllowed('#', 'subscribe')).toBe(false);
    expect(gatewayTopicAllowed(`recall/v1/s/${ME}/up/upload`, 'publish')).toBe(false);
    expect(gatewayTopicAllowed('recall/v1/s/+/down/ack', 'publish')).toBe(false);
    expect(gatewayTopicAllowed(`recall/v1/s/${ME}/down/money`, 'publish')).toBe(false);
    // Another user name with the gateway's client id prefix is a screen as far as topics go.
    expect(
      authz(CFG, {
        clientid: 'recall-gateway-x',
        username: 'other',
        topic: '#',
        action: 'subscribe',
      }),
    ).toBe(false);
  });

  it('secrets compare in constant time, any length', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', 'x')).toBe(false);
  });

  it('the broker settings take only plain values (a value cannot break the file)', () => {
    const v = {
      SSL_PORT: '8883',
      TCP_BIND: '10.0.0.5:1883',
      CERT_DIR: '/certs',
      HOOK_URL: 'http://10.0.0.6:8090',
      HOOK_TOKEN: 'abc123',
      NODE_COOKIE: 'cookie',
    };
    const conf = renderEmqxConfig(v);
    expect(conf).toContain('bind = "0.0.0.0:8883"');
    expect(conf).toContain('"authorization" = "Bearer abc123"');
    expect(conf).toContain('peer_cert_as_username = md5');
    expect(conf).toContain('verify = verify_peer');
    expect(conf).toContain('no_match = deny');
    expect(conf).not.toMatch(/\{\{/);
    expect(() => renderEmqxConfig({ ...v, HOOK_TOKEN: 'a" }\nauthentication = []' })).toThrow();
  });
});
