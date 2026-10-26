// P3.11.1: riders: an application, details as versions (one phone and one plate per rider), the
// documents and their review, the steps (approve needs the documents, active needs a screen fitted,
// leaving needs it off), notes and the page.
import { fakeBankCheck, fakeDeviceCa, fakeEsign, fakeFileStore, fakeKyc } from '@recall/adapters';
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
import {
  checkRiderBank,
  refreshRiderChecks,
  sendAgreement,
  startIdentityCheck,
} from '../../src/rider-checks.js';
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
    // Already ended on 1 June: refused at the look (rejected instead, he sends the new one).
    await expect(look(ins.docId, 'accepted', '2027-05-31')).rejects.toThrow(
      'This insurance ended on 2027-05-31',
    );
    await look(ins.docId, 'rejected');
    await expect(look(ins.docId, 'accepted', '2028-05-31')).rejects.toThrow('already looked at');
    await expect(stepRider(pool, id, 'approved', 'Omar', 'looks fine', NOW)).rejects.toThrow(
      'Insurance rejected: send again',
    );
    const renewed = await uploadRiderDocument(
      pool,
      store,
      { riderId: id, kind: 'insurance', data: file('ad-1280x640.webp'), by: 'app' },
      NOW + 10,
    );
    await look(renewed.docId, 'accepted', '2028-05-31');

    // Identity, the agreement and the bank (P3.11.2), through the providers' fakes.
    await expect(
      stepRider(pool, id, 'approved', 'Omar', 'documents checked', NOW + 20),
    ).rejects.toThrow('Identity (KYC) not started; Agreement not started; Bank or UPI not started');
    const kyc = fakeKyc();
    const esign = fakeEsign({ auto: true, clock: () => NOW + 15 });
    const bank = fakeBankCheck({ failFor: new Map([['000111222333', 'account closed']]) });
    const k = await startIdentityCheck(pool, kyc, id, 'Omar', NOW + 11);
    await sendAgreement(pool, esign, id, 'Omar', NOW + 12);
    expect(await refreshRiderChecks(pool, { kyc, esign }, id, NOW + 13)).toBe(1); // signed
    const ref = k.link.split('/').pop() ?? '';
    kyc.finish(ref, { state: 'verified', nameOnId: 'SURESH REDDY', idLast4: '9876' });
    expect(await refreshRiderChecks(pool, { kyc, esign }, id, NOW + 14)).toBe(1);
    expect(
      await checkRiderBank(
        pool,
        bank,
        id,
        { kind: 'bank', accountNumber: '000111222333', ifsc: 'HDFC0001234', name: 'Ravi Kumar' },
        { who: 'Omar', superAdmin: false },
        NOW + 15,
      ),
    ).toEqual({ outcome: 'failed', reason: 'account closed', nameAtBank: null });
    await expect(
      stepRider(pool, id, 'approved', 'Omar', 'documents checked', NOW + 20),
    ).rejects.toThrow(
      'Identity (KYC) verified: "SURESH REDDY" does not match "Ravi Kumar"; Bank or UPI failed: account closed',
    );
    // His identity again (a mistaken ID the first time), and a good UPI id.
    const k2 = await startIdentityCheck(pool, kyc, id, 'Omar', NOW + 16);
    kyc.finish(k2.link.split('/').pop() ?? '', {
      state: 'verified',
      nameOnId: 'RAVI KUMAR',
      idLast4: '1234',
    });
    await refreshRiderChecks(pool, { kyc, esign }, id, NOW + 17);
    await checkRiderBank(
      pool,
      bank,
      id,
      { kind: 'upi', vpa: 'ravi@okaxis', name: 'Ravi Kumar' },
      { who: 'Omar', superAdmin: false },
      NOW + 18,
    );
    await stepRider(pool, id, 'approved', 'Omar', 'documents checked', NOW + 20);
    const page = await riderPage(pool, id, NOW + 30);
    expect(page?.rider.status).toBe('approved');
    expect(page?.checklist.every((c) => c.done)).toBe(true);
    expect(page?.documents.map((d) => d.kind)).toEqual(['insurance', 'insurance', 'rc', 'photo']);
    expect(page?.payoutAccount).toBe('UPI ravi@okaxis · Ravi Kumar');
    expect(page?.checks.map((c) => [c.kind, c.state, c.name, c.idLast4])).toEqual([
      ['agreement', 'passed', 'RAVI KUMAR', null],
      ['bank', 'passed', 'RAVI KUMAR', null],
      ['identity', 'passed', 'RAVI KUMAR', '1234'],
    ]);
    // An account in another name never passes; once approved, only a super admin moves his pay.
    const other = fakeBankCheck();
    await expect(
      checkRiderBank(
        pool,
        other,
        id,
        { kind: 'upi', vpa: 'suresh@okaxis', name: 'Suresh Reddy' },
        { who: 'Omar', superAdmin: false },
        NOW + 40,
      ),
    ).rejects.toThrow('a super admin changes it');
    expect(
      await checkRiderBank(
        pool,
        other,
        id,
        { kind: 'upi', vpa: 'suresh@okaxis', name: 'Suresh Reddy' },
        { who: 'Prateek', superAdmin: true },
        NOW + 41,
      ),
    ).toEqual({
      outcome: 'failed',
      reason: 'the bank holds it as "SURESH REDDY", not "Ravi Kumar"',
      nameAtBank: null,
    });
    expect((await riderPage(pool, id, NOW + 42))?.payoutAccount).toBe(
      'UPI ravi@okaxis · Ravi Kumar',
    );
    // An account written in without a check is never where he is paid.
    await pool.query(
      `INSERT INTO rider_payout_accounts (rider_id, destination, set_by)
       VALUES ($1, '{"kind":"upi","vpa":"evil@okaxis","name":"Ravi Kumar"}', 'someone')`,
      [id],
    );
    expect((await riderPage(pool, id, NOW + 43))?.payoutAccount).toBeNull();
    // Once approved, his name cannot drift from the name on his ID.
    await expect(
      reviseRider(
        pool,
        id,
        { ...ravi, apps: ['swiggy'], rides: 'Kondapur', name: 'Suresh Reddy' },
        'Omar',
        'typo',
        NOW + 44,
      ),
    ).rejects.toThrow('"Suresh Reddy" does not match the name on his ID ("RAVI KUMAR")');
    // Only the account that passed is where he is paid.
    const paid = await pool.query(
      "SELECT count(*)::int AS n FROM rider_payout_accounts WHERE rider_id = 'RD-000001'",
    );
    expect(paid.rows[0]?.n).toBe(2); // the checked one, and the one written in (never paid)
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

  it('a fitting checks the rider: on record, approved, his own bike; phones and plates come free when he leaves', async () => {
    const ca = fakeDeviceCa();
    const box = await enrolScreen(pool, ca, boxRequest('RK-RIDER-2'), 'w', NOW);
    await expect(
      fitScreen(pool, { qr: box.qr, plate: 'TS09EA1234', riderId: 'RD-999999' }, 'f', NOW + 200),
    ).rejects.toThrow('No rider RD-999999');
    const fresh = await createRider(
      pool,
      {
        details: {
          name: 'New Rider',
          phone: '+919000000002',
          bikePlate: 'TS07AB0001',
          rides: '',
          apps: [],
        },
        channel: 'app',
        by: 'app',
        reason: 'signed up',
      },
      NOW + 200,
    );
    await expect(
      fitScreen(pool, { qr: box.qr, plate: 'TS07AB0001', riderId: fresh }, 'f', NOW + 210),
    ).rejects.toThrow(`${fresh} is applied: only an approved rider gets a screen`);
    // RD-000001 left: his phone and plate may go to someone new.
    const next = await createRider(
      pool,
      {
        details: { ...ravi, apps: [], name: 'Bike Buyer' },
        channel: 'app',
        by: 'app',
        reason: 'bought the bike',
      },
      NOW + 220,
    );
    // If RD-000001 comes back, his old phone and plate are someone else's now.
    await expect(
      stepRider(pool, 'RD-000001', 'applied', 'Omar', 'back in Hyderabad', NOW + 230),
    ).rejects.toThrow(`This phone is already rider ${next}`);
    // An approved rider fitted on someone else's plate: refused.
    await pool.query(
      `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at)
       VALUES ($1, 2, 'approved', 'test', 'test', now())`,
      [fresh],
    );
    await expect(
      fitScreen(pool, { qr: box.qr, plate: 'TS09EA1234', riderId: fresh }, 'f', NOW + 240),
    ).rejects.toThrow(`TS09EA1234 is not ${fresh}'s bike (his record says TS07AB0001)`);
    await fitScreen(pool, { qr: box.qr, plate: 'TS07AB0001', riderId: fresh }, 'f', NOW + 250);
    // His plate cannot change while the screen is on that bike.
    await expect(
      reviseRider(
        pool,
        fresh,
        { name: 'New Rider', phone: '+919000000002', bikePlate: 'TS07AB0002', rides: '', apps: [] },
        'Omar',
        'new bike',
        NOW + 260,
      ),
    ).rejects.toThrow('take it off before changing the number plate');
    // A phone typed with a 0 in front, a plate with dashes.
    expect((await riderList(pool, { q: '09000000002' })).map((r) => r.riderId)).toEqual([fresh]);
    expect((await riderList(pool, { q: 'ts-07-ab' })).map((r) => r.riderId)).toEqual([fresh]);
  });
});
