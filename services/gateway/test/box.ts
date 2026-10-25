// A box as it leaves the warehouse (P2.1): two keys in its secure store, enrolled, with its
// certificate. Used by the gateway tests.
import type { DeviceCaAdapter } from '@recall/adapters';
import { enrolScreen } from '@recall/db';
import { enrolmentBytes } from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import type pg from 'pg';

export interface TestBox {
  readonly screenId: string;
  readonly certPem: string;
  readonly keyPem: string;
  readonly caCertPem: string;
  readonly certSerial: string;
}

export async function enrolBox(
  pool: pg.Pool,
  ca: DeviceCaAdapter,
  serial: string,
  now: number,
): Promise<TestBox> {
  const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const play = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = (k: typeof tls.publicKey) =>
    k.export({ format: 'der', type: 'spki' }).toString('base64');
  const req = {
    hardwareSerial: serial,
    model: 'Test LED box',
    tlsPublicKey: spki(tls.publicKey),
    playPublicKey: spki(play.publicKey),
    madeAt: now,
  };
  const bytes = Buffer.from(enrolmentBytes(req));
  const e = await enrolScreen(
    pool,
    ca,
    {
      ...req,
      tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
      playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
    },
    'test-warehouse',
    now,
  );
  return {
    screenId: e.screenId,
    certPem: e.certPem,
    keyPem: tls.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    caCertPem: e.caCertPem,
    certSerial: e.certSerial,
  };
}

/** A live position report (P1.2.4), the simplest report a box sends. */
export const live = (t: number) => ({
  kind: 'live' as const,
  t,
  lat: 17.4485,
  lng: 78.3908,
  place: 'madhapur',
  moving: true,
});
