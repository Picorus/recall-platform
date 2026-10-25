import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fakeDeviceCa } from '../src/device-ca.js';

describe('fake certificate authority for screens (P2.1)', () => {
  it("issues a certificate for the screen's own key, naming its id, signed by the CA", async () => {
    const ca = fakeDeviceCa();
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const issued = await ca.issue({
      screenId: 'SCR-7K3M9SYX',
      publicKey: spki,
      notBefore: 1_800_000_000,
      notAfter: 1_800_000_000 + 2 * 365 * 86_400,
    });
    const cert = new X509Certificate(issued.certPem);
    const root = new X509Certificate(await ca.caCertPem());
    expect(cert.subject).toBe('CN=SCR-7K3M9SYX');
    expect(cert.verify(root.publicKey)).toBe(true);
    expect(cert.checkIssued(root)).toBe(true);
    expect(cert.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')).toBe(spki);
    expect(cert.ca).toBe(false);
    expect(root.ca).toBe(true);
    expect(new Date(cert.validTo).getTime() / 1000).toBe(1_800_000_000 + 2 * 365 * 86_400);
    const second = await ca.issue({
      screenId: 'SCR-1234567M',
      publicKey: spki,
      notBefore: 0,
      notAfter: 1,
    });
    expect(second.serial).not.toBe(issued.serial);
    expect(issued.serial).toMatch(/^[0-9a-f]{16}$/);
    expect(cert.toLegacyObject().subjectaltname).toBeUndefined();
    expect(cert.toString()).toContain('BEGIN CERTIFICATE');
  });
});
