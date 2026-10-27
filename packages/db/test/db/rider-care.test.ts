// P4.8: a rider reports a screen problem from the app: a support conversation with him starts (a
// stolen screen marked urgent), the photo is kept for staff, a few a day; his reports and where
// each stands.
import { fakeFileStore } from '@recall/adapters';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { problemsOfThread, reportScreenProblem, riderProblems } from '../../src/rider-care.js';
import { createRider } from '../../src/riders.js';
import { stepThread, supportThread } from '../../src/support.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const store = fakeFileStore({ baseUrl: 'http://files', secret: 's' });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
let riderId = '';
const phone = '+919811188888';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  riderId = await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone, bikePlate: 'TS09EA8888', rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    NOW - 86_400,
  );
}, 60_000);
afterAll(async () => db.drop());

describe('screen problems from the rider app (P4.8)', () => {
  it('a report starts a conversation with him; a theft is urgent; the photo is for staff', async () => {
    const r = await reportScreenProblem(
      pool,
      store,
      { riderId, phone, kind: 'theft', note: 'Taken outside Inorbit mall', photo: PNG },
      NOW,
    );
    const t = await supportThread(pool, r.threadId);
    expect(t).toMatchObject({
      subject: 'URGENT: screen stolen (no screen on record)',
      channel: 'whatsapp',
      contact: phone,
      state: 'open',
    });
    expect(t?.timeline.find((e) => e.kind === 'in')?.text).toContain(
      'He says: Taken outside Inorbit mall',
    );
    const [p] = await problemsOfThread(pool, r.threadId);
    expect(p).toMatchObject({ kind: 'theft', screenId: null });
    expect(p?.photoKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(p?.photoKey ?? '')).not.toBeNull();
    // Shown in the audit log as started from the rider app.
    const audit = await pool.query(`SELECT who, action FROM audit_log WHERE ref = $1 ORDER BY at`, [
      r.threadId,
    ]);
    expect(audit.rows[0]).toMatchObject({ who: 'rider app', action: 'conversation started' });
  });

  it('his reports and where each stands; something else needs words; a few a day', async () => {
    await expect(
      reportScreenProblem(
        pool,
        store,
        { riderId, phone, kind: 'other', note: '', photo: null },
        NOW,
      ),
    ).rejects.toMatchObject({ why: { code: 'say-what' } });
    await expect(
      reportScreenProblem(
        pool,
        store,
        { riderId, phone, kind: 'fire', note: '', photo: null },
        NOW,
      ),
    ).rejects.toMatchObject({ why: { code: 'bad-kind' } });
    await expect(
      reportScreenProblem(
        pool,
        store,
        { riderId, phone, kind: 'damage', note: '', photo: new TextEncoder().encode('%PDF-1.4') },
        NOW,
      ),
    ).rejects.toMatchObject({ why: { code: 'not-a-photo' } });
    const d = await reportScreenProblem(
      pool,
      store,
      { riderId, phone, kind: 'not-on', note: '', photo: null },
      NOW + 60,
    );
    await stepThread(
      pool,
      d.threadId,
      { state: 'done', owner: null, reason: 'reset it on the phone' },
      { id: 'sara' },
      NOW + 120,
    );
    const mine = await riderProblems(pool, riderId);
    expect(mine.map((p) => [p.kind, p.state])).toEqual([
      ['not-on', 'done'],
      ['theft', 'open'],
    ]);
    for (let i = 0; i < 3; i++)
      await reportScreenProblem(
        pool,
        store,
        { riderId, phone, kind: 'damage', note: '', photo: null },
        NOW + 200 + i,
      );
    await expect(
      reportScreenProblem(
        pool,
        store,
        { riderId, phone, kind: 'damage', note: '', photo: null },
        NOW + 300,
      ),
    ).rejects.toMatchObject({ why: { code: 'too-many-reports' } });
    // Tomorrow, again.
    await reportScreenProblem(
      pool,
      store,
      { riderId, phone, kind: 'damage', note: '', photo: null },
      NOW + 86_400 + 400,
    );
  });
});
