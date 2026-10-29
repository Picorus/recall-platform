// P3.17: settings are saved as new versions by a super admin only, with why; a stale edit is refused;
// nothing is lost; the wording reaches the messages; every save is in the audit log.
import { fakeMessages } from '@recall/adapters';
import { DEFAULT_SETTINGS, launchAreas } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { auditLog } from '../../src/audit.js';
import { saveSetting, setting, settingRecords } from '../../src/settings.js';
import { receiveMessage, replyThread } from '../../src/support.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const PRATEEK = { id: 'STF-000000000001', role: 'super-admin' };
const centre = { name: 'Kukatpally warehouse', address: 'Plot 4, KPHB Phase 1', on: true };

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
}, 60_000);
afterAll(async () => db.drop());

describe('settings (P3.17)', () => {
  it('the defaults until saved; then each save a new version, with who and why', async () => {
    const before = await settingRecords(pool);
    expect(before.loanBank).toMatchObject({ value: { name: 'Dhanlaxmi Bank' }, version: 0 });
    expect(before.fittingCentres.value).toEqual([]);
    expect(
      await saveSetting(pool, 'fittingCentres', [centre], PRATEEK, 'First centre opened', 0),
    ).toBe(1);
    expect(
      await saveSetting(
        pool,
        'fittingCentres',
        [centre, { name: 'Gachibowli', address: 'Near DLF gate 2', on: true }],
        PRATEEK,
        'Second centre',
        1,
      ),
    ).toBe(2);
    const after = await settingRecords(pool);
    expect(after.fittingCentres).toMatchObject({
      version: 2,
      savedBy: PRATEEK.id,
      reason: 'Second centre',
    });
    expect((await setting(pool, 'fittingCentres')).map((c) => c.name)).toEqual([
      'Kukatpally warehouse',
      'Gachibowli',
    ]);
  });

  it('refused: not a super admin, no why, a stale version, nothing changing, a centre removed', async () => {
    const two = await setting(pool, 'fittingCentres');
    await expect(
      saveSetting(pool, 'loanBank', { name: 'X Bank' }, { id: 'S', role: 'admin' }, 'reason', 0),
    ).rejects.toThrow('Only a super admin');
    await expect(
      saveSetting(pool, 'loanBank', { name: 'X Bank' }, PRATEEK, 'no', 0),
    ).rejects.toThrow('Why');
    // Someone else saved version 2 while this one was looking at version 1.
    await expect(
      saveSetting(pool, 'fittingCentres', [...two], PRATEEK, 'old screen', 1),
    ).rejects.toThrow('meanwhile');
    await expect(
      saveSetting(pool, 'fittingCentres', [...two], PRATEEK, 'same again', 2),
    ).rejects.toThrow('Nothing changes');
    await expect(
      saveSetting(pool, 'fittingCentres', [centre], PRATEEK, 'drop Gachibowli', 2),
    ).rejects.toThrow('switch it off');
    await expect(
      saveSetting(
        pool,
        'regularZone',
        { kind: 'areas', areaIds: ['hyd-nowhere'], withEdge: false },
        PRATEEK,
        'after the POC',
        0,
      ),
    ).rejects.toThrow('no published area hyd-nowhere');
    await expect(saveSetting(pool, 'support', { days: [] }, PRATEEK, 'hours', 0)).rejects.toThrow(
      'Support numbers',
    );
    // The database refuses edits and gaps too.
    await expect(pool.query("UPDATE settings SET reason = 'changed'")).rejects.toThrow();
    // P1.7.5: the old single pay zone is history only (pocZone and regularZone replace it).
    await expect(
      pool.query(
        `INSERT INTO settings (key, version, value, saved_by, reason)
         VALUES ('payZone', 1, '{}', 'prateek', 'the old key')`,
      ),
    ).rejects.toThrow('replaced by pocZone and regularZone');
    await expect(
      pool.query(
        `INSERT INTO settings (key, version, value, saved_by, reason)
         VALUES ('loanBank', 5, '{"name":"Y Bank"}', 'x', 'skipping ahead')`,
      ),
    ).rejects.toThrow('version 1');
  });

  it('two saves at once from the same version: one wins, the other is told to reload', async () => {
    const results = await Promise.allSettled(
      ['Bank A', 'Bank B'].map((name) =>
        saveSetting(pool, 'loanBank', { name }, PRATEEK, 'bank changed', 0),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await settingRecords(pool)).loanBank.version).toBe(1);
  });

  it('the support reply uses the wording in force', async () => {
    const w = DEFAULT_SETTINGS.messages;
    await saveSetting(
      pool,
      'messages',
      {
        ...w,
        supportReply: {
          whatsappTemplate: 'support_reply_v2',
          emailSubject: 'About: {subject}',
          emailText: 'Hello,\n\n{reply}\n\nTeam RECALL <support>',
        },
      },
      PRATEEK,
      'Friendlier replies',
      0,
    );
    const t = await receiveMessage(
      pool,
      {
        channel: 'email',
        providerId: 'mail-9',
        from: 'ops@chai.example.in',
        subject: 'Invoice',
        text: 'Please resend',
        at: NOW,
      },
      NOW,
    );
    const messages = fakeMessages();
    await replyThread(pool, messages, t.threadId, 'Done {subject}', { id: 'S', name: 'Sana' }, NOW);
    expect(messages.sent).toMatchObject([
      {
        subject: 'About: Invoice',
        // A placeholder typed in the reply itself stays as typed.
        text: 'Hello,\n\nDone {subject}\n\nTeam RECALL <support>',
        html: '<p>Hello,</p><p>Done {subject}</p><p>Team RECALL &#60;support&#62;</p>',
      },
    ]);
  });

  it('every save is in the audit log, under settings', async () => {
    const { rows } = await auditLog(pool, { area: 'settings' });
    expect(rows.map((r) => [r.action, r.ref, r.detail])).toEqual([
      ['setting saved', 'messages v1', 'Friendlier replies'],
      ['setting saved', 'loanBank v1', 'bank changed'],
      ['setting saved', 'fittingCentres v2', 'Second centre'],
      ['setting saved', 'fittingCentres v1', 'First centre opened'],
    ]);
  });
});
