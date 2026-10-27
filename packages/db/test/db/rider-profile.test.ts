// P4.11: the rider app's profile: his details, papers and where he is paid; his requests (bank
// change, leave, delete) each open a support conversation once while one is open.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { riderProfile, riderRequest } from '../../src/rider-profile.js';
import { createRider } from '../../src/riders.js';
import { stepThread, supportThread } from '../../src/support.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 24, 9, 30) / 1000;
const phone = '+919811166001';
let riderId = '';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  riderId = await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone, bikePlate: 'TS09EA6001', rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    NOW - 86_400,
  );
}, 60_000);
afterAll(async () => db.drop());

describe('rider profile (P4.11)', () => {
  it('his details and papers; no account yet; requests open once each', async () => {
    expect(await riderProfile(pool, riderId, NOW)).toMatchObject({
      riderId,
      name: 'Ravi Kumar',
      shown: '+91 98111 66001',
      bikePlate: 'TS09EA6001',
      documents: { photo: { state: 'todo' }, rc: { state: 'todo' }, insurance: { state: 'todo' } },
      account: null,
      open: [],
    });
    expect(await riderRequest(pool, { riderId, phone, kind: 'delete' }, NOW)).toEqual({
      isNew: true,
    });
    // Asked again while it is open: no second conversation.
    expect(await riderRequest(pool, { riderId, phone, kind: 'delete' }, NOW + 60)).toEqual({
      isNew: false,
    });
    await riderRequest(pool, { riderId, phone, kind: 'bank-change' }, NOW + 120);
    expect((await riderProfile(pool, riderId, NOW)).open).toEqual(['bank-change', 'delete']);
    const t = await pool.query<{ thread_id: string; kind: string }>(
      'SELECT thread_id, kind FROM rider_requests WHERE rider_id = $1 ORDER BY at',
      [riderId],
    );
    expect(t.rows.map((r) => r.kind)).toEqual(['delete', 'bank-change']);
    const del = await supportThread(pool, t.rows[0]?.thread_id ?? '');
    expect(del).toMatchObject({ subject: 'URGENT: account deletion request', contact: phone });
    // No account numbers are asked for or written.
    const bank = await supportThread(pool, t.rows[1]?.thread_id ?? '');
    expect(bank?.timeline.find((e) => e.kind === 'in')?.text).toContain('No account details');
    // Once support marks it done, he may ask again.
    await stepThread(
      pool,
      t.rows[1]?.thread_id ?? '',
      { state: 'done', owner: null, reason: 'changed on a call' },
      { id: 'prateek' },
      NOW + 200,
    );
    expect((await riderProfile(pool, riderId, NOW)).open).toEqual(['delete']);
    await expect(
      riderRequest(pool, { riderId, phone, kind: 'everything' }, NOW),
    ).rejects.toMatchObject({ why: { code: 'bad-kind' } });
  });
});
