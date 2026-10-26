import { randomBytes } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  base32,
  fromBase32,
  hashPassword,
  otpauthUri,
  passwordMatches,
  readKey,
  seal,
  totpCode,
  totpStep,
  unseal,
} from '../../src/secrets.js';
import { callerIp } from '../../src/staff-api.js';

// RFC 6238 appendix B (SHA-1, secret "12345678901234567890", 8 digits).
const RFC = base32(Buffer.from('12345678901234567890'));

describe('two-step codes', () => {
  it('match the RFC 6238 test values', () => {
    const cases: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of cases) expect(totpCode(RFC, Math.floor(t / 30), 8)).toBe(code);
  });

  it('accept now and one step either side, nothing further', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(totpStep(RFC, totpCode(RFC, step), now)).toBe(step);
    expect(totpStep(RFC, totpCode(RFC, step - 1), now)).toBe(step - 1);
    expect(totpStep(RFC, totpCode(RFC, step + 1), now)).toBe(step + 1);
    expect(totpStep(RFC, totpCode(RFC, step - 2), now)).toBeUndefined();
    expect(totpStep(RFC, 'abcdef', now)).toBeUndefined();
    expect(totpStep(RFC, '12345', now)).toBeUndefined();
  });

  it('a code is used once', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(totpStep(RFC, totpCode(RFC, step), now, step)).toBeUndefined();
    expect(totpStep(RFC, totpCode(RFC, step + 1), now, step)).toBe(step + 1);
  });

  it('base32 reads back', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (b) =>
        fromBase32(base32(b)).equals(Buffer.from(b)),
      ),
    );
  });

  it('the QR text names RECALL and the member', () => {
    expect(otpauthUri('ABC', 'a@b.in')).toBe(
      'otpauth://totp/RECALL%3Aa%40b.in?secret=ABC&issuer=RECALL&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('passwords', () => {
  it('are kept as salted scrypt hashes and checked', async () => {
    const h = await hashPassword('green kettle 42 mango');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h).not.toContain('kettle');
    expect(await hashPassword('green kettle 42 mango')).not.toBe(h);
    expect(await passwordMatches('green kettle 42 mango', h)).toBe(true);
    expect(await passwordMatches('green kettle 42 mangO', h)).toBe(false);
    expect(await passwordMatches('x', 'plain')).toBe(false);
    expect(await passwordMatches('x', 'scrypt$99999999$8$1$aa$bb')).toBe(false);
  });
});

describe('secrets kept encrypted', () => {
  const key = randomBytes(32);
  it('read back with the key only, and any change is noticed', () => {
    const s = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(s).not.toContain('JBSWY3DP');
    expect(unseal(key, s)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => unseal(randomBytes(32), s)).toThrow();
    const parts = s.split('.');
    const data = Buffer.from(parts[3] ?? '', 'base64url');
    data[0] = (data[0] ?? 0) ^ 1;
    expect(() =>
      unseal(key, [...parts.slice(0, 3), data.toString('base64url')].join('.')),
    ).toThrow();
  });

  it('the key must be 32 bytes', () => {
    expect(readKey('ab'.repeat(32)).length).toBe(32);
    expect(() => readKey('abcd')).toThrow('32 bytes');
  });
});

describe('the caller address sign-in limits count', () => {
  it('without proxies: the connection itself; IPv6 by its /64', () => {
    expect(callerIp('1.2.3.4', '10.0.0.9', 0)).toBe('10.0.0.9');
    expect(callerIp(undefined, '::ffff:10.0.0.9', 0)).toBe('10.0.0.9');
    expect(callerIp(undefined, '2001:db8:aa:bb:1:2:3:4', 0)).toBe('2001:db8:aa:bb::/64');
    expect(callerIp(undefined, '2001:db8::1', 0)).toBe('2001:db8:0:0::/64');
  });

  it('behind our proxies: the entry the outermost one added, never what the caller wrote', () => {
    // The caller wrote "6.6.6.6"; our load balancer saw 1.2.3.4; the API sees the balancer.
    expect(callerIp('6.6.6.6, 1.2.3.4', '10.0.0.2', 1)).toBe('1.2.3.4');
    // CDN, then load balancer: two hops.
    expect(callerIp('6.6.6.6, 1.2.3.4, 172.16.0.5', '10.0.0.2', 2)).toBe('1.2.3.4');
    expect(callerIp(undefined, '10.0.0.2', 1)).toBe('unknown');
  });
});
