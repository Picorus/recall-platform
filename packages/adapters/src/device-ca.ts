// P2.1: the certificate authority for screens (hard rule 4: behind an adapter with a working fake).
// Each screen gets an X.509 certificate for its secure line (MQTT over TLS), naming its screen id.
// The real one keeps its signing key in a key store (P6); the fake makes a key in memory, so the
// system runs on a laptop with no keys.
import 'reflect-metadata'; // needed by the certificate library
import { randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

export interface IssuedCertificate {
  readonly serial: string;
  readonly certPem: string;
  /** UTC seconds. */
  readonly notBefore: number;
  readonly notAfter: number;
}

export interface DeviceCaAdapter {
  /** The CA's own certificate, which screens and the MQTT broker trust. */
  caCertPem(): Promise<string>;
  /** A certificate for a screen's public key (P-256, SubjectPublicKeyInfo DER, base64). */
  issue(req: {
    readonly screenId: string;
    readonly publicKey: string;
    readonly notBefore: number;
    readonly notAfter: number;
  }): Promise<IssuedCertificate>;
}

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

/**
 * A working fake CA: a fresh key and self-signed CA certificate in memory (a new one each time the
 * system starts, so certificates from an earlier run no longer chain: re-enrol on a laptop).
 */
export function fakeDeviceCa(name = 'RECALL screens (laptop fake)'): DeviceCaAdapter {
  const ready = (async () => {
    const keys = (await webcrypto.subtle.generateKey(ALG, true, [
      'sign',
      'verify',
    ])) as webcrypto.CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: `CN=${name}`,
      notBefore: new Date(Date.UTC(2026, 0, 1)),
      notAfter: new Date(Date.UTC(2046, 0, 1)),
      keys,
      signingAlgorithm: ALG,
      extensions: [
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(
          x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
          true,
        ),
      ],
    });
    return { keys, cert };
  })();
  const issued = new Set<string>();
  return {
    caCertPem: async () => (await ready).cert.toString('pem'),
    async issue(req) {
      const ca = await ready;
      const publicKey = await webcrypto.subtle.importKey(
        'spki',
        Buffer.from(req.publicKey, 'base64'),
        ALG,
        true,
        ['verify'],
      );
      // Random 64-bit serials (as certificate rules require), never one twice from this CA.
      let serial = '';
      while (!serial || issued.has(serial)) {
        const b = randomBytes(8);
        b[0] = ((b[0] ?? 0) & 0x7f) | 0x10; // positive, 16 hex digits
        serial = b.toString('hex');
      }
      issued.add(serial);
      const cert = await x509.X509CertificateGenerator.create({
        serialNumber: serial,
        subject: `CN=${req.screenId}`,
        issuer: ca.cert.subject,
        notBefore: new Date(req.notBefore * 1000),
        notAfter: new Date(req.notAfter * 1000),
        signingAlgorithm: ALG,
        publicKey,
        signingKey: ca.keys.privateKey,
        extensions: [
          await x509.SubjectKeyIdentifierExtension.create(publicKey),
          await x509.AuthorityKeyIdentifierExtension.create(ca.cert),
          new x509.BasicConstraintsExtension(false, undefined, true),
          new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
          new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
        ],
      });
      return {
        serial,
        certPem: cert.toString('pem'),
        notBefore: req.notBefore,
        notAfter: req.notAfter,
      };
    },
  };
}
