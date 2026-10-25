import { describe, expect, it } from 'vitest';
import { renderEmqxConfig } from '../../src/emqx-config.js';
import { authz, gatewayTopicAllowed, sameSecret, type HookConfig } from '../../src/hooks.js';

const CFG: HookConfig = { token: 't0ken', gatewayUser: 'recall-gateway', gatewayPassword: 'pw' };
const ME = 'SCR-0123456Z';
const gw = { clientid: 'recall-gateway-ab12', username: 'recall-gateway' };

/** A database that must not be asked: topics refused by name never reach it. */
const noDb = {
  query: () => {
    throw new Error('the database was asked');
  },
} as never;
const NOW = 1_790_000_000;

describe('gateway hooks (P2.3.2): who may use which topic', () => {
  it("a screen: never another screen's topics, wildcards or other actions (refused by name)", async () => {
    const asks = (topic: string, action: string, clientid = ME, username = 'f'.repeat(32)) =>
      authz(noDb, CFG, { clientid, username, topic, action }, NOW);
    expect(await asks('recall/v1/s/SCR-00000000/up/upload', 'publish')).toBe(false);
    expect(await asks('recall/v1/s/+/up/+', 'subscribe')).toBe(false);
    expect(await asks('$share/gateway/recall/v1/s/+/up/+', 'subscribe')).toBe(false);
    expect(await asks(`recall/v1/s/${ME}/up/upload`, 'all')).toBe(false);
    expect(await asks(`recall/v1/s/${ME}/down/ack`, 'publish')).toBe(false);
    // A screen naming itself the gateway (its user name is its certificate's fingerprint).
    expect(await asks('recall/v1/s/+/up/+', 'subscribe', 'recall-gateway-x')).toBe(false);
    // Its own topics are allowed only after its certificate is checked again (database tests).
    await expect(asks(`recall/v1/s/${ME}/up/upload`, 'publish')).rejects.toThrow('asked');
  });

  it('the gateway: every up topic to read, any screen down topic to write, nothing else', async () => {
    expect(
      await authz(noDb, CFG, { ...gw, topic: 'recall/v1/s/+/up/+', action: 'subscribe' }, NOW),
    ).toBe(true);
    expect(
      await authz(
        noDb,
        CFG,
        { ...gw, topic: `recall/v1/s/${ME}/down/ack`, action: 'publish' },
        NOW,
      ),
    ).toBe(true);
    expect(gatewayTopicAllowed('#', 'subscribe')).toBe(false);
    expect(gatewayTopicAllowed(`recall/v1/s/${ME}/up/upload`, 'publish')).toBe(false);
    expect(gatewayTopicAllowed('recall/v1/s/+/down/ack', 'publish')).toBe(false);
    expect(gatewayTopicAllowed(`recall/v1/s/${ME}/down/money`, 'publish')).toBe(false);
    // Another user name with the gateway's client id prefix is a screen as far as topics go.
    expect(
      await authz(
        noDb,
        CFG,
        { clientid: 'recall-gateway-x', username: 'other', topic: '#', action: 'subscribe' },
        NOW,
      ),
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
      HOOK_TOKEN: 'a'.repeat(32),
      NODE_COOKIE: 'c'.repeat(32),
    };
    const conf = renderEmqxConfig(v);
    expect(conf).toContain('bind = "0.0.0.0:8883"');
    expect(conf).toContain(`"authorization" = "Bearer ${'a'.repeat(32)}"`);
    expect(conf).toContain('retain_available = false');
    expect(conf).toContain('listen_address = "127.0.0.1"');
    expect(() => renderEmqxConfig({ ...v, HOOK_TOKEN: 'short' })).toThrow('at least 32');
    expect(() => renderEmqxConfig({ ...v, NODE_COOKIE: 'short' })).toThrow('at least 32');
    expect(conf).toContain('peer_cert_as_username = md5');
    expect(conf).toContain('verify = verify_peer');
    expect(conf).toContain('no_match = deny');
    expect(conf).not.toMatch(/\{\{/);
    expect(() => renderEmqxConfig({ ...v, HOOK_TOKEN: 'a" }\nauthentication = []' })).toThrow();
  });
});
