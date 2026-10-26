// P3.11.1: riders: an application, details as versions (one phone and one plate per rider), the
// documents and their review, the steps (approve needs the documents, active needs a screen fitted,
// leaving needs it off), notes and the page.
import { fakeDeviceCa, fakeFileStore } from '@recall/adapters';
import { enrolmentBytes } from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addRiderNote,
  createRider,
  reviewRiderDocument,
  reviseRider,
  riderList,
  riderPage,
  stepRider,
  uploadRiderDocument,
} from '../../src/riders.js';
import { enrolScreen, fitScreen, unfitScreen, type SignedEnrolment } from '../../src/screens.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 5, 1, 6, 30) / 1000;
const store = fakeFileStore({ baseUrl: 'http://localhost:8080/files', secret: 'test' });
const file = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`../../../domain/test/fixtures/ads/${name}`, import.meta.url)),
  );
const ravi = {
  name: 'Ravi Kumar',
  phone: '+919848012345',
  bikePlate: 'TS09EA1234',
  rides: 'Madhapur, Hitech City',
  apps: ['swiggy', 'rapido'] as const,
};

function boxRequest(serial: string): SignedEnrolment {
  const tls = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const play = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = (k: typeof tls.publicKey) =>
    k.export({ format: 'der', type: 'spki' }).toString('base64');
  const req = {
    hardwareSerial: serial,
    model: 'VendorX LED28 v1',
    tlsPublicKey: spki(tls.publicKey),
    playPublicKey: spki(play.publicKey),
    madeAt: NOW,
  };
  const bytes = Buffer.from(enrolmentBytes(req));
  return {
    ...req,
    tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
    playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
  };
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
}, 120_000);
afterAll(async () => db.drop());

describe('riders (P3.11.1)', () => {
  it('an application; details change as versions; one phone and one plate per rider', async () => {
    const id = await createRider(
      pool,
      {
        details: { ...ravi, apps: [...ravi.apps] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in at the warehouse',
      },
      NOW,
    );
    expect(id).toBe('RD-000001');
    await expect(
      createRider(
        pool,
        {
          details: { ...ravi, apps: [], name: 'Someone Else', bikePlate: null },
          channel: 'app',
          by: 'app',
          reason: 'signed up',
        },
        NOW,
      ),
    ).rejects.toThrow('This phone is already rider RD-000001');
    await expect(
      createRider(
        pool,
        {
          details: { ...ravi, apps: [], phone: '+919000000001' },
          channel: 'app',
          by: 'app',
          reason: 'signed up',
        },
        NOW,
      ),
    ).rejects.toThrow('This number plate is already rider RD-000001');
    await expect(
      createRider(
        pool,
        {
          details: { ...ravi, apps: [], phone: '98480' },
          channel: 'app',
          by: 'app',
          reason: 'signed up',
        },
        NOW,
      ),
    ).rejects.toThrow('phone must be an Indian mobile number');
    expect(
      await reviseRider(
        pool,
        id,
        { ...ravi, apps: ['swiggy'], rides: 'Kondapur' },
        'Omar',
        'he moved',
        NOW + 60,
      ),
    ).toBe(2);
    expect(await riderList(pool, { q: '98480' })).toMatchObject([
      { riderId: id, status: 'applied', rides: 'Kondapur', version: 2 },
    ]);
    expect(await riderList(pool, { q: 'ts09 ea' })).toHaveLength(1);
    expect(await riderList(pool, { status: 'active' })).toEqual([]);
  });

  it('documents read from their bytes, looked at once; approval needs all three (insurance in date)', async () => {
    const id = 'RD-000001';
    await expect(stepRider(pool, id, 'approved', 'Omar', 'looks fine', NOW)).rejects.toThrow(
      'not ready: Photo not sent; Registration (RC) not sent; Insurance not sent',
    );
    await expect(
      uploadRiderDocument(
        pool,
        store,
        {
          riderId: id,
          kind: 'rc',
          data: new TextEncoder().encode('<html>hello</html>'),
          by: 'Omar',
        },
        NOW,
      ),
    ).rejects.toThrow('Send a photo (JPEG, PNG, WebP) or a PDF');
    const pdf = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
    await expect(
      uploadRiderDocument(pool, store, { riderId: id, kind: 'photo', data: pdf, by: 'Omar' }, NOW),
    ).rejects.toThrow('His photo must be a picture');
    const photo = await uploadRiderDocument(
      pool,
      store,
      { riderId: id, kind: 'photo', data: file('ad-1280x640.jpg'), by: 'app' },
      NOW,
    );
    const rc = await uploadRiderDocument(
      pool,
      store,
      { riderId: id, kind: 'rc', data: pdf, by: 'app' },
      NOW,
    );
    const ins = await uploadRiderDocument(
      pool,
      store,
      { riderId: id, kind: 'insurance', data: file('ad-1280x640.png'), by: 'app' },
      NOW,
    );
    expect([photo.fileType, rc.fileType, ins.fileType]).toEqual(['jpeg', 'pdf', 'png']);
    const look = (
      docId: string,
      decision: 'accepted' | 'rejected',
      expiresOn: string | null = null,
    ) =>
      reviewRiderDocument(
        pool,
        {
          riderId: id,
          docId,
          decision,
          reason: 'checked against the original',
          expiresOn,
          by: 'Omar',
        },
        NOW,
      );
    await look(photo.docId, 'accepted');
    await look(rc.docId, 'accepted');
    await expect(look(ins.docId, 'accepted')).rejects.toThrow(
      'Give the last day the insurance covers',
    );
    await expect(look(ins.docId, 'accepted', '2027-02-30')).rejects.toThrow('Give the last day');
    await look(ins.docId, 'accepted', '2027-05-31'); // already lapsed on 1 June
    await expect(look(ins.docId, 'rejected')).rejects.toThrow('already looked at');
    await expect(stepRider(pool, id, 'approved', 'Omar', 'looks fine', NOW)).rejects.toThrow(
      'Insurance expired 2027-05-31',
    );
    const renewed = await uploadRiderDocument(
      pool,
      store,
      { riderId: id, kind: 'insurance', data: file('ad-1280x640.webp'), by: 'app' },
      NOW + 10,
    );
    await look(renewed.docId, 'accepted', '2028-05-31');
    await stepRider(pool, id, 'approved', 'Omar', 'documents checked', NOW + 20);
    const page = await riderPage(pool, id, NOW + 30);
    expect(page?.rider.status).toBe('approved');
    expect(page?.checklist.every((c) => c.done)).toBe(true);
    expect(page?.documents.map((d) => d.kind)).toEqual(['insurance', 'insurance', 'rc', 'photo']);
  });

  it('active only with a screen fitted, leaving only after it comes off; notes; the timeline', async () => {
    const id = 'RD-000001';
    await expect(stepRider(pool, id, 'active', 'Omar', 'riding now', NOW + 40)).rejects.toThrow(
      'fit a screen to his bike first',
    );
    const ca = fakeDeviceCa();
    const box = await enrolScreen(pool, ca, boxRequest('RK-RIDER-1'), 'w', NOW);
    await fitScreen(pool, { qr: box.qr, plate: 'TS09EA1234', riderId: id }, 'fitter', NOW + 50);
    await stepRider(pool, id, 'active', 'Omar', 'screen fitted today', NOW + 60);
    await expect(
      stepRider(pool, id, 'left', 'Omar', 'moving to Chennai', NOW + 70),
    ).rejects.toThrow('take his screen off first');
    await unfitScreen(pool, box.screenId, 'rider leaving', 'fitter', NOW + 80);
    await stepRider(pool, id, 'left', 'Omar', 'moving to Chennai', NOW + 90);
    await addRiderNote(pool, id, 'Returned the screen in good shape', 'Sara', NOW + 100);
    const page = await riderPage(pool, id, NOW + 110);
    expect(page?.rider.status).toBe('left');
    expect(page?.screenId).toBeNull();
    expect(page?.timeline.slice(0, 3).map((t) => t.text)).toEqual([
      'Note: Returned the screen in good shape',
      'Left RECALL: moving to Chennai',
      'Riding (active): screen fitted today',
    ]);
    await expect(pool.query("UPDATE rider_steps SET reason = 'x'")).rejects.toThrow();
  });
});
