// P4.2: joining on the rider app. A new number signs up and his session follows his new record; a
// walk-in staff added is found by his number instead; each step's state as he sees it, from to do
// to done; his details change only while his application is open.
import { fakeBankCheck, fakeEsign, fakeFileStore, fakeKyc, fakeMessages } from '@recall/adapters';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RIDER_SIGN_IN as R } from '@recall/domain';
import {
  beforeAppCheck,
  changeOwnDetails,
  joinAsRider,
  joinPage,
  RIDER_APP,
} from '../../src/rider-app.js';
import {
  checkRiderBank,
  refreshRiderChecks,
  sendAgreement,
  startIdentityCheck,
} from '../../src/rider-checks.js';
import { askRiderCode, checkRiderCode, riderSession } from '../../src/rider-sign-in.js';
import {
  createRider,
  reviewRiderDocument,
  stepRider,
  uploadRiderDocument,
} from '../../src/riders.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SECRET = Buffer.alloc(32, 9);
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const messages = fakeMessages();
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4,
]);

/** Signs a number in and returns its session. */
async function signIn(phone: string, ip: string, at = NOW) {
  await askRiderCode(
    pool,
    messages,
    { phone, channel: 'whatsapp', ip, language: 'en' },
    SECRET,
    at,
  );
  const m = messages.sent.at(-1);
  const code = m?.channel === 'whatsapp' ? (m.params[0] ?? '') : '';
  const { token } = await checkRiderCode(pool, { phone, code, ip }, SECRET, at);
  const s = await riderSession(pool, token, at);
  if (!s) throw new Error('no session');
  return { token, s };
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
}, 60_000);
afterAll(async () => db.drop());

describe('joining on the rider app (P4.2)', () => {
  it('a new number signs up; his session now opens his record; once only', async () => {
    const phone = '+919900011111';
    const { token, s } = await signIn(phone, '10.1.0.1');
    expect(s.riderId).toBeNull();
    const details = {
      name: 'Suresh Babu',
      phone,
      bikePlate: null,
      rides: 'Kukatpally',
      apps: ['swiggy' as const],
    };
    const riderId = await joinAsRider(pool, s, details, NOW + 10);
    expect(riderId).toMatch(/^RD-/);
    const again = await riderSession(pool, token, NOW + 20);
    expect(again?.riderId).toBe(riderId);
    await expect(joinAsRider(pool, again ?? s, details, NOW + 30)).rejects.toThrow('already');
    await expect(joinAsRider(pool, s, details, NOW + 30)).rejects.toThrow('already');
    const rec = await pool.query('SELECT channel, created_by FROM riders WHERE rider_id = $1', [
      riderId,
    ]);
    expect(rec.rows[0]).toEqual({ channel: 'app', created_by: RIDER_APP });
    // Someone else's number cannot be put on it.
    const other = await signIn('+919900011112', '10.1.0.2');
    await expect(
      joinAsRider(pool, other.s, { ...details, phone: '+919900099999' }, NOW + 40),
    ).rejects.toThrow('signed in with');
  });

  it('a walk-in staff added: his new session finds that record, no second one is made', async () => {
    const phone = '+919900022222';
    const walkIn = await createRider(
      pool,
      {
        details: { name: 'Imran Khan', phone, bikePlate: null, rides: '', apps: [] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      NOW - 3600,
    );
    const { s } = await signIn(phone, '10.2.0.1');
    // Signed in after staff added him: already his.
    expect(s.riderId).toBe(walkIn);
  });

  it('each step goes from to do to done; the loan comes last', async () => {
    const phone = '+919900033333';
    const { s } = await signIn(phone, '10.3.0.1');
    const riderId = await joinAsRider(
      pool,
      s,
      { name: 'Venkat Rao', phone, bikePlate: 'TS09EA1234', rides: 'Madhapur', apps: ['rapido'] },
      NOW,
    );
    let page = await joinPage(pool, riderId, NOW);
    expect(page.steps).toEqual([
      { step: 'profile', state: 'todo' },
      { step: 'vehicle', state: 'todo' },
      { step: 'identity', state: 'todo' },
      { step: 'bank', state: 'todo' },
      { step: 'agreement', state: 'todo' },
      { step: 'loan', state: 'later' },
    ]);
    const store = fakeFileStore({ baseUrl: 'http://files', secret: 's' });
    const ids: Record<string, string> = {};
    for (const kind of ['photo', 'rc', 'insurance'] as const)
      ids[kind] = (
        await uploadRiderDocument(pool, store, { riderId, kind, data: PNG, by: RIDER_APP }, NOW)
      ).docId;
    page = await joinPage(pool, riderId, NOW);
    expect(page.steps.slice(0, 2)).toEqual([
      { step: 'profile', state: 'waiting' },
      { step: 'vehicle', state: 'waiting' },
    ]);
    await reviewRiderDocument(
      pool,
      {
        riderId,
        docId: ids.photo ?? '',
        decision: 'accepted',
        reason: 'clear',
        expiresOn: null,
        by: 'Omar',
      },
      NOW,
    );
    await reviewRiderDocument(
      pool,
      {
        riderId,
        docId: ids.rc ?? '',
        decision: 'rejected',
        reason: 'blurred',
        expiresOn: null,
        by: 'Omar',
      },
      NOW,
    );
    await reviewRiderDocument(
      pool,
      {
        riderId,
        docId: ids.insurance ?? '',
        decision: 'accepted',
        reason: 'in date',
        expiresOn: '2028-08-01',
        by: 'Omar',
      },
      NOW,
    );
    page = await joinPage(pool, riderId, NOW);
    expect(page.documents.rc.state).toBe('again');
    expect(page.steps.slice(0, 2).map((x) => x.state)).toEqual(['done', 'again']);
    // ID, agreement and bank through the stand-ins.
    const kyc = fakeKyc({ auto: true });
    const esign = fakeEsign({ auto: true });
    await startIdentityCheck(pool, kyc, riderId, RIDER_APP, NOW);
    await sendAgreement(pool, esign, riderId, RIDER_APP, NOW);
    expect((await joinPage(pool, riderId, NOW)).identity.state).toBe('waiting');
    await refreshRiderChecks(pool, { kyc, esign }, riderId, NOW + 5);
    await checkRiderBank(
      pool,
      fakeBankCheck(),
      riderId,
      { kind: 'upi', vpa: 'venkat@okaxis', name: 'Venkat Rao' },
      { who: RIDER_APP, superAdmin: false },
      NOW + 6,
    );
    page = await joinPage(pool, riderId, NOW + 10);
    expect(page.steps.slice(2).map((x) => x.state)).toEqual(['done', 'done', 'done', 'later']);
    const rc = await uploadRiderDocument(
      pool,
      store,
      { riderId, kind: 'rc', data: PNG, by: RIDER_APP },
      NOW + 20,
    );
    await reviewRiderDocument(
      pool,
      {
        riderId,
        docId: rc.docId,
        decision: 'accepted',
        reason: 'clear now',
        expiresOn: null,
        by: 'Omar',
      },
      NOW + 30,
    );
    page = await joinPage(pool, riderId, NOW + 40);
    expect(page.steps.map((x) => x.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'todo',
    ]);
    // His details while his application is open; not after.
    await changeOwnDetails(
      pool,
      riderId,
      {
        name: 'Venkat Rao',
        phone,
        bikePlate: 'TS09EA1234',
        rides: 'Madhapur, Kondapur',
        apps: ['rapido', 'uber'],
      },
      NOW + 50,
    );
    expect((await joinPage(pool, riderId, NOW + 60)).details.apps).toEqual(['rapido', 'uber']);
    // His bank account was checked against his name: the name now stays (P7.1).
    await expect(
      changeOwnDetails(
        pool,
        riderId,
        { name: 'Someone Else', phone, bikePlate: 'TS09EA1234', rides: '', apps: [] },
        NOW + 55,
      ),
    ).rejects.toThrow('bank account was checked');
    await expect(
      changeOwnDetails(
        pool,
        riderId,
        {
          name: 'Venkat Rao',
          phone: '+919900033334',
          bikePlate: 'TS09EA1234',
          rides: '',
          apps: [],
        },
        NOW + 60,
      ),
    ).rejects.toThrow('support');
    await stepRider(pool, riderId, 'approved', 'Omar', 'all checked', NOW + 70);
    expect((await joinPage(pool, riderId, NOW + 80)).canChange).toBe(false);
    await expect(
      changeOwnDetails(
        pool,
        riderId,
        { name: 'Venkat Rao', phone, bikePlate: 'TS09EA1234', rides: 'x', apps: [] },
        NOW + 90,
      ),
    ).rejects.toThrow('decided');
  });

  it('a number given out again never opens the old rider; his new owner signs up afresh', async () => {
    const phone = '+919900044444';
    const old = await createRider(
      pool,
      {
        details: { name: 'Old Owner', phone, bikePlate: null, rides: '', apps: [] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      NOW - 7200,
    );
    await stepRider(pool, old, 'left', 'Omar', 'moved to Pune', NOW - 3600);
    const { s } = await signIn(phone, '10.4.0.1');
    expect(s.riderId).toBeNull();
    const fresh = await joinAsRider(
      pool,
      s,
      { name: 'New Owner', phone, bikePlate: null, rides: 'Uppal', apps: [] },
      NOW,
    );
    expect(fresh).not.toBe(old);
    expect((await joinPage(pool, fresh, NOW)).details.name).toBe('New Owner');
  });

  it("checks from the app: a waiting one opens again, a few a day, the bank's name never shown", async () => {
    const phone = '+919900055555';
    const { s } = await signIn(phone, '10.5.0.1');
    const riderId = await joinAsRider(
      pool,
      s,
      { name: 'Lakshmi Devi', phone, bikePlate: null, rides: '', apps: [] },
      NOW,
    );
    expect(await beforeAppCheck(pool, riderId, 'identity', NOW, R)).toBeNull();
    const started = await startIdentityCheck(pool, fakeKyc(), riderId, RIDER_APP, NOW);
    // Still waiting: the same link, nothing new paid for.
    expect(await beforeAppCheck(pool, riderId, 'identity', NOW + 60, R)).toBe(started.link);
    // A bank account in someone else's name: the rider is told only that it is not his.
    const bank = fakeBankCheck();
    for (let i = 0; i < R.checksPerRiderDay; i++) {
      await beforeAppCheck(pool, riderId, 'bank', NOW + i, R);
      await checkRiderBank(
        pool,
        bank,
        riderId,
        { kind: 'upi', vpa: `x${i}@okaxis`, name: 'Somebody Else' },
        { who: RIDER_APP, superAdmin: false },
        NOW + i,
      );
    }
    const page = await joinPage(pool, riderId, NOW + 10);
    expect(page.bank).toEqual({ state: 'again', reason: 'the name on the account is not yours' });
    expect(JSON.stringify(page)).not.toContain('Somebody');
    await expect(beforeAppCheck(pool, riderId, 'bank', NOW + 20, R)).rejects.toThrow(
      'Too many tries today',
    );
    // Tomorrow, again.
    expect(await beforeAppCheck(pool, riderId, 'bank', NOW + 86_400 + 60, R)).toBeNull();
    // A brake for everyone together.
    await expect(
      beforeAppCheck(pool, riderId, 'agreement', NOW + 30, { ...R, checksPerDayAll: 2 }),
    ).rejects.toThrow('busy');
  });
});
