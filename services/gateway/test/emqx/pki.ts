// The broker's own certificate for the test (the screens check it), from a throwaway authority.
import 'reflect-metadata';
import { createPrivateKey, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);
const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

export async function brokerCertificate(): Promise<{
  caPem: string;
  certPem: string;
  keyPem: string;
}> {
  const gen = () =>
    webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']) as Promise<webcrypto.CryptoKeyPair>;
  const caKeys = await gen();
  const now = Date.now();
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=RECALL broker test authority',
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + 86_400_000),
    keys: caKeys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });
  const keys = await gen();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=localhost',
    issuer: ca.subject,
    notBefore: new Date(now - 3_600_000),
    notAfter: new Date(now + 86_400_000),
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      await x509.AuthorityKeyIdentifierExtension.create(ca),
    ],
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const keyPem = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  return { caPem: ca.toString('pem'), certPem: cert.toString('pem'), keyPem };
}
