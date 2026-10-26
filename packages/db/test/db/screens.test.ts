import { fakeDeviceCa } from '@recall/adapters';
import { enrolmentBytes, isScreenId } from '@recall/domain';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { revokeScreenKey } from '../../src/plays.js';
import { assignScreen } from '../../src/rider-pay.js';
import {
  enrolScreen,
  fitScreen,
  screenStatus,
  unfitScreen,
  type SignedEnrolment,
} from '../../src/screens.js';
import { approvedRider, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 6, 1, 6) / 1000;
const ca = fakeDeviceCa();

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await approvedRider(pool, 'RD-000001', 'TS09EA1234');
  await approvedRider(pool, 'RD-000002', 'TS09EA1234');
  await approvedRider(pool, 'RD-000003', 'TS10AB5678');
  await approvedRider(pool, 'RD-000009', 'TS11CD4321');
  await approvedRider(pool, 'RD-000401', 'TS09EB1234');
  await approvedRider(pool, 'RD-000402', 'TS09EB1234');
}, 120_000);
afterAll(async () => db.drop());

/** What a box does at the warehouse: two keys in its secure store, a request signed with both. */
function boxRequest(serial: string, madeAt = NOW): SignedEnrolment {
  const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const play = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = (k: typeof tls.publicKey) =>
    k.export({ format: 'der', type: 'spki' }).toString('base64');
  const req = {
    hardwareSerial: serial,
    model: 'VendorX LED28 v1',
    tlsPublicKey: spki(tls.publicKey),
    playPublicKey: spki(play.publicKey),
    madeAt,
  };
  const bytes = Buffer.from(enrolmentBytes(req));
  return {
    ...req,
    tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
    playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
  };
}

describe('screens: enrolment and fitting (P2.1)', () => {
  it('a box is enrolled once: an id, a certificate for its own key, its play key recorded', async () => {
    const req = boxRequest('RK3566-0A1B2C3D');
    const e = await enrolScreen(pool, ca, req, 'warehouse-1', NOW);
    expect(isScreenId(e.screenId)).toBe(true);
    expect(e.qr).toBe(`RECALL1:${e.screenId}`);
    const cert = new X509Certificate(e.certPem);
    expect(cert.subject).toBe(`CN=${e.screenId}`);
    expect(cert.verify(new X509Certificate(e.caCertPem).publicKey)).toBe(true);
    expect(cert.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')).toBe(
      req.tlsPublicKey,
    );
    const key = await pool.query<{ public_key: string }>(
      `SELECT public_key FROM screen_keys WHERE screen_id = $1 AND key_id = 'k1'`,
      [e.screenId],
    );
    expect(key.rows[0]?.public_key).toBe(req.playPublicKey);
    await expect(
      enrolScreen(pool, ca, boxRequest('RK3566-0A1B2C3D'), 'warehouse-1', NOW),
    ).rejects.toThrow(`already enrolled as ${e.screenId}`);
  });

  it('refused: a stale request, a request not signed by both keys', async () => {
    await expect(
      enrolScreen(pool, ca, boxRequest('RK-STALE-1', NOW - 3600), 'w', NOW),
    ).rejects.toThrow('not fresh');
    const r = boxRequest('RK-FORGED-1');
    const other = boxRequest('RK-FORGED-2');
    await expect(
      enrolScreen(pool, ca, { ...r, playSignature: other.playSignature }, 'w', NOW),
    ).rejects.toThrow('not signed by both keys');
    await expect(
      enrolScreen(pool, ca, { ...r, model: 'changed after signing' }, 'w', NOW),
    ).rejects.toThrow('not signed by both keys');
  });

  it('fitting by QR: one screen per bike, one per rider; the same scan again changes nothing; rider pay follows', async () => {
    const a = await enrolScreen(pool, ca, boxRequest('RK-A-0001'), 'w', NOW);
    const b = await enrolScreen(pool, ca, boxRequest('RK-B-0002'), 'w', NOW);
    const t = NOW + 3600;
    const f = await fitScreen(
      pool,
      { qr: a.qr, plate: 'ts 09 ea 1234', riderId: 'RD-000001' },
      'fitter',
      t,
    );
    expect(f).toEqual({ screenId: a.screenId, bike: 'TS09EA1234', riderId: 'RD-000001', from: t });
    expect(
      await fitScreen(
        pool,
        { qr: a.qr, plate: 'TS09EA1234', riderId: 'RD-000001' },
        'fitter',
        t + 60,
      ),
    ).toEqual(f);
    await expect(
      fitScreen(pool, { qr: b.qr, plate: 'TS09EA1234', riderId: 'RD-000002' }, 'fitter', t + 60),
    ).rejects.toThrow('TS09EA1234 already carries');
    await expect(
      fitScreen(pool, { qr: b.qr, plate: 'TS10AB5678', riderId: 'RD-000001' }, 'fitter', t + 60),
    ).rejects.toThrow("TS10AB5678 is not RD-000001's bike");
    await expect(
      fitScreen(pool, { qr: a.qr, plate: 'TS10AB5678', riderId: 'RD-000003' }, 'fitter', t + 60),
    ).rejects.toThrow('take it off that bike first');
    await expect(
      fitScreen(pool, { qr: 'hello', plate: 'TS10AB5678', riderId: 'RD-000003' }, 'fitter', t),
    ).rejects.toThrow('not a RECALL screen QR');
    await expect(
      fitScreen(pool, { qr: b.qr, plate: '1234', riderId: 'RD-000003' }, 'fitter', t),
    ).rejects.toThrow('number plate');
    const rider = await pool.query<{ rider_id: string }>(
      `SELECT rider_id FROM rider_screens WHERE screen_id = $1 ORDER BY from_at DESC LIMIT 1`,
      [a.screenId],
    );
    expect(rider.rows[0]?.rider_id).toBe('RD-000001');

    // Taken off, then the bike can take another screen and the rider another bike.
    await unfitScreen(pool, a.screenId, 'rider left', 'ops', t + 7200);
    expect((await screenStatus(pool, a.screenId, t + 7200))?.fitting).toBeUndefined();
    expect((await screenStatus(pool, a.screenId, t + 100))?.fitting?.bike).toBe('TS09EA1234'); // history kept
    await fitScreen(
      pool,
      { qr: b.qr, plate: 'TS09EA1234', riderId: 'RD-000001' },
      'fitter',
      t + 7300,
    );
    await expect(unfitScreen(pool, a.screenId, 'again', 'ops', t + 7400)).rejects.toThrow(
      'not on a bike',
    );
  });

  it('a screen reported stolen, or not enrolled, cannot be fitted', async () => {
    const s = await enrolScreen(pool, ca, boxRequest('RK-S-0003'), 'w', NOW);
    await revokeScreenKey(pool, s.screenId, 'k1', 'ops', 'stolen from the bike', NOW + 10);
    await expect(
      fitScreen(pool, { qr: s.qr, plate: 'TS11CD4321', riderId: 'RD-000009' }, 'fitter', NOW + 20),
    ).rejects.toThrow('lost or stolen');
    await expect(
      fitScreen(
        pool,
        { qr: 'RECALL1:SCR-7K3M9SYX', plate: 'TS11CD4321', riderId: 'RD-000009' },
        'fitter',
        NOW,
      ),
    ).rejects.toThrow('not enrolled');
  });

  it('records cannot be changed', async () => {
    await expect(pool.query(`UPDATE screens SET model = 'x'`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM screen_fittings`)).rejects.toThrow();
  });

  describe('found in review', () => {
    it('a key belongs to one screen, in one role: a copied key is refused', async () => {
      const first = boxRequest('RK-KEY-0001');
      await enrolScreen(pool, ca, first, 'w', NOW);
      const copy = boxRequest('RK-KEY-0002');
      // A second box presenting the first box's play key (both signatures redone with real keys is
      // impossible without the private key, so here the copier holds it: same keys, new serial).
      await expect(
        enrolScreen(pool, ca, { ...first, hardwareSerial: 'RK-KEY-0002' }, 'w', NOW),
      ).rejects.toThrow(/not signed|already belongs/);
      expect(copy.playPublicKey).not.toBe(first.playPublicKey);
      await expect(
        pool.query(
          `INSERT INTO screen_keys (screen_id, key_id, public_key, added_by) VALUES ('x', 'k9', $1, 't')`,
          [first.playPublicKey],
        ),
      ).rejects.toThrow(/screen_keys_public_key/);
    });

    it('two enrolments of one box at the same moment: one certificate only', async () => {
      const r = boxRequest('RK-RACE-0001');
      const both = await Promise.allSettled([
        enrolScreen(pool, ca, r, 'w', NOW),
        enrolScreen(pool, ca, { ...r }, 'w', NOW),
      ]);
      expect(both.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
      const certs = await pool.query(
        `SELECT 1 FROM screen_certificates c JOIN screens s USING (screen_id)
          WHERE s.hardware_serial = 'RK-RACE-0001'`,
      );
      expect(certs.rowCount).toBe(1);
    });

    it('an enrolled screen moves only with its fitting, so fitting and rider pay never disagree', async () => {
      const e = await enrolScreen(pool, ca, boxRequest('RK-PAY-0001'), 'w', NOW);
      await expect(assignScreen(pool, e.screenId, 'R-777', NOW + 10, 'ops')).rejects.toThrow(
        'use fitScreen',
      );
    });

    it('one bike written two ways is still one bike; changes at the same moment are refused cleanly', async () => {
      const a = await enrolScreen(pool, ca, boxRequest('RK-PL-0001'), 'w', NOW);
      const b = await enrolScreen(pool, ca, boxRequest('RK-PL-0002'), 'w', NOW);
      const t = NOW + 50_000;
      await fitScreen(pool, { qr: a.qr, plate: 'TS9EB1234', riderId: 'RD-000401' }, 'f', t);
      await expect(
        fitScreen(pool, { qr: b.qr, plate: 'TS09EB1234', riderId: 'RD-000402' }, 'f', t + 5),
      ).rejects.toThrow('TS09EB1234 already carries');
      await expect(unfitScreen(pool, a.screenId, 'swap', 'ops', t)).rejects.toThrow('try again');
      await unfitScreen(pool, a.screenId, 'swap', 'ops', t + 1);
      await expect(
        fitScreen(pool, { qr: a.qr, plate: 'TS09EB1234', riderId: 'RD-000401' }, 'f', t + 1),
      ).rejects.toThrow('try again');
    });
  });
});
