import { fakeDeviceCa } from '@recall/adapters';
import { enrolmentBytes } from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { revokeScreenKey } from '../../src/plays.js';
import {
  certFingerprint,
  lastHello,
  recordHello,
  recordRefusal,
  revokeCertificate,
  screenMayConnect,
} from '../../src/screen-line.js';
import { enrolScreen, FIRST_PLAY_KEY } from '../../src/screens.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 6, 1, 6) / 1000;
const ca = fakeDeviceCa();

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
}, 120_000);
afterAll(async () => db.drop());

async function enrol(serial: string) {
  const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const play = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = (k: typeof tls.publicKey) =>
    k.export({ format: 'der', type: 'spki' }).toString('base64');
  const req = {
    hardwareSerial: serial,
    model: 'Test LED box',
    tlsPublicKey: spki(tls.publicKey),
    playPublicKey: spki(play.publicKey),
    madeAt: NOW,
  };
  const bytes = Buffer.from(enrolmentBytes(req));
  return enrolScreen(
    pool,
    ca,
    {
      ...req,
      tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
      playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
    },
    'test',
    NOW,
  );
}

const ask = (clientId: string, certPem: string, at = NOW, commonName = clientId) =>
  screenMayConnect(pool, { clientId, commonName, fingerprint: certFingerprint(certPem) }, at);

describe('screen line in the database (P2.3.2)', () => {
  it('only a certificate we issued to this very screen, in date, opens the line', async () => {
    const a = await enrol('LINE-A-0001');
    const b = await enrol('LINE-B-0001');
    expect(await ask(a.screenId, a.certPem)).toEqual({ ok: true, serial: a.certSerial });
    // B's certificate presented as A (and as A's name): not A's.
    expect(await ask(a.screenId, b.certPem, NOW, a.screenId)).toMatchObject({ ok: false });
    // The name in the certificate must be the screen; no TLS (empty name) never passes.
    expect(await ask(a.screenId, a.certPem, NOW, '')).toMatchObject({ ok: false });
    expect(await ask(b.screenId, a.certPem, NOW, b.screenId)).toMatchObject({ ok: false });
    // A certificate from someone else's authority with the right name (EMQX would refuse it at
    // the handshake; the gateway does too).
    const other = await fakeDeviceCa('someone else').issue({
      screenId: a.screenId,
      publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64'),
      notBefore: NOW - 60,
      notAfter: NOW + 86_400,
    });
    expect(await ask(a.screenId, other.certPem)).toEqual({
      ok: false,
      reason: 'not a certificate we issued to this screen',
    });
    // Out of date: before it starts, and from the moment it ends.
    expect(await ask(a.screenId, a.certPem, NOW - 7200)).toMatchObject({ ok: false });
    expect(await ask(a.screenId, a.certPem, NOW + 2 * 365 * 86_400)).toEqual({
      ok: false,
      reason: 'the certificate is out of date',
    });
    expect(
      await screenMayConnect(
        pool,
        { clientId: 'not-a-screen', commonName: 'not-a-screen', fingerprint: 'x' },
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('a revoked certificate, or a screen reported lost, is refused', async () => {
    const a = await enrol('LINE-C-0001');
    await revokeCertificate(pool, a.certSerial, 'box retired', 'ops-1', NOW);
    expect(await ask(a.screenId, a.certPem)).toEqual({
      ok: false,
      reason: 'the certificate was revoked',
    });
    await expect(revokeCertificate(pool, a.certSerial, 'again', 'ops-1', NOW)).rejects.toThrow();
    await expect(revokeCertificate(pool, a.certSerial, 'x', 'ops-1', NOW)).rejects.toThrow();
    const b = await enrol('LINE-D-0001');
    await revokeScreenKey(pool, b.screenId, FIRST_PLAY_KEY, 'ops-1', 'stolen from the bike', NOW);
    expect(await ask(b.screenId, b.certPem)).toEqual({
      ok: false,
      reason: 'the screen was reported lost or stolen',
    });
  });

  it('hellos and refusals are kept; the last hello is the last contact', async () => {
    const a = await enrol('LINE-E-0001');
    expect(await lastHello(pool, a.screenId)).toBeUndefined();
    await recordHello(pool, a.screenId, '0.1.0', NOW * 1000);
    await recordHello(pool, a.screenId, '0.1.1', NOW * 1000 + 61_000);
    await recordHello(pool, a.screenId, '0.1.1', NOW * 1000 + 61_000); // same moment: kept once
    expect(await lastHello(pool, a.screenId)).toEqual({ at: NOW * 1000 + 61_000, app: '0.1.1' });
    await recordRefusal(pool, a.screenId, 'upload', 'too big', 300_000, NOW * 1000);
    const r = await pool.query('SELECT kind, problem, bytes FROM screen_line_refusals');
    expect(r.rows).toEqual([{ kind: 'upload', problem: 'too big', bytes: 300_000 }]);
    await expect(pool.query('DELETE FROM screen_hellos')).rejects.toThrow();
  });
});
