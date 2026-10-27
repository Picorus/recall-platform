// P3.16: the audit log: every record of who did what, in one timeline, newest first; searched by
// words, part and time; page by page without skipping or repeating; as a file; and nothing left out:
// every table that records who did something is in the log (a new one fails here until it is).
import { launchAreas, PRICE_BOOK_V1 } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveAreaVersion } from '../../src/areas.js';
import { auditCsv, auditLog } from '../../src/audit.js';
import { addBookingNote } from '../../src/booking-desk.js';
import { createBooking, savePriceBook } from '../../src/bookings.js';
import { createRider, stepRider } from '../../src/riders.js';
import { noteThread, openThread } from '../../src/support.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000;

/** Columns that say who did something. */
const WHO = /^(by|by_who|.+_by)$/;
/** Tables with such a column that are not actions by a person or the system worth listing. */
const NOT_ACTIONS = new Set<string>([]);

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const a of launchAreas('2026-11-01T00:00:00.000Z'))
    await saveAreaVersion(pool, { ...a, draft: false }, 'system');
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  await createBooking(
    pool,
    {
      bookingId: 'BK-AU-1',
      brandId: 'chai-co',
      request: {
        lines: [
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 19, bikes: 30 },
          { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 20, bikes: 30 },
        ],
        repeatMonths: 1,
        channel: 'admin',
      },
      by: 'Sana',
    },
    NOW,
  );
  await addBookingNote(pool, 'BK-AU-1', 'Client wants evening hours only', 'Sana', NOW + 60);
  const rider = await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone: '+919848012345', bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    NOW + 120,
  );
  await stepRider(pool, rider, 'rejected', 'Omar', 'no licence', NOW + 180).catch(() => undefined);
  // Two support notes alike in all but their text, in the same second.
  const sunita = { id: 'STF-00000000000a', name: 'Sunita' };
  const thread = await openThread(
    pool,
    { channel: 'phone', contact: '+919000011111', subject: 'Call', note: 'Called back' },
    sunita,
    NOW - 600,
  );
  await noteThread(pool, thread, 'First note', sunita, NOW - 500);
  await noteThread(pool, thread, 'Second note', sunita, NOW - 500);
  // A sign-in refused for an address that is no member; a limit set, then lifted.
  await pool.query(
    `INSERT INTO staff_sign_ins (email, ok, why, ip, at)
     VALUES ('my-password-typed-here', false, 'wrong', '10.0.0.1', to_timestamp($1))`,
    [NOW - 400],
  );
  for (const [version, max] of [
    [1, 10],
    [2, null],
  ] as const)
    await pool.query(
      `INSERT INTO area_hour_limits (area_id, day, start_hour, version, max_bikes, set_by, set_at)
       VALUES ('hyd-madhapur', '2027-08-27', 19, $1, $2, 'Sana', to_timestamp($3))`,
      [version, max, NOW - 300 + version],
    );
}, 60_000);
afterAll(async () => db.drop());

describe('the audit log (P3.16)', () => {
  it('nothing left out: every table that records who did something is in the log', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'`,
    );
    const tables = [
      ...new Set(cols.rows.filter((c) => WHO.test(c.column_name)).map((c) => c.table_name)),
    ].filter((t) => !NOT_ACTIONS.has(t));
    const view = await pool.query<{ def: string }>(
      "SELECT pg_get_viewdef('audit_log'::regclass, true) AS def",
    );
    const def = view.rows[0]?.def ?? '';
    const missing = tables.filter((t) => !new RegExp(`\\b${t}\\b`).test(def)).sort();
    expect(missing).toEqual([]);
  });

  it('newest first, with who, part, what, about what and why; searched by words and part', async () => {
    const { rows } = await auditLog(pool);
    expect(rows[0]).toMatchObject({
      area: 'riders',
      who: 'Omar',
      ref: expect.stringMatching(/^RD-/),
    });
    expect(rows.map((r) => r.at)).toEqual([...rows.map((r) => r.at)].sort((a, b) => b - a));
    const note = await auditLog(pool, { text: 'note BK-AU-1' });
    expect(note.rows).toMatchObject([
      { area: 'bookings', action: 'booking note', who: 'Sana', ref: 'BK-AU-1', detail: '' },
    ]);
    expect((await auditLog(pool, { area: 'prices' })).rows).toMatchObject([
      { action: 'price book saved', who: 'prateek', ref: 'v1' },
    ]);
    // "%" and "_" are letters to find, not wildcards.
    expect((await auditLog(pool, { text: '%' })).rows).toEqual([]);
    // Adding a rider: his record, his first details and his first step.
    expect(
      (await auditLog(pool, { from: NOW + 100, to: NOW + 130 })).rows.map((r) => r.action).sort(),
    ).toEqual(['rider added', 'rider applied', 'rider details set']);
  });

  it('page by page, nothing skipped or repeated; as a file', async () => {
    const all = (await auditLog(pool, { limit: 500 })).rows;
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = await auditLog(pool, { limit: 3, ...(before ? { before } : {}) });
      seen.push(...page.rows.map((r) => `${r.at}|${r.action}|${r.ref}`));
      before = page.next ?? undefined;
    } while (before);
    expect(seen).toEqual(all.map((r) => `${r.at}|${r.action}|${r.ref}`));
    await expect(auditLog(pool, { before: 'nonsense' })).rejects.toThrow('Which page');
    const csv = await auditCsv(pool, { area: 'bookings' });
    expect(csv.cut).toBe(false);
    expect(csv.csv.split('\r\n')[0]).toBe('time (India),who,part,what,about,detail');
    expect(csv.csv).toContain('booking note');
  });

  it('entries alike in the same second page apart; no NULL; nothing personal', async () => {
    const notes = [];
    let before: string | undefined;
    do {
      const page = await auditLog(pool, {
        area: 'support',
        limit: 1,
        ...(before ? { before } : {}),
      });
      notes.push(...page.rows.filter((r) => r.action === 'support note'));
      before = page.next ?? undefined;
    } while (before);
    // The call's own note, then the two in the same second.
    expect(notes).toHaveLength(3);
    const all = (await auditLog(pool, { limit: 500 })).rows;
    for (const r of all) for (const v of Object.values(r)) expect(v).not.toBeNull();
    const text = JSON.stringify(all);
    for (const secret of ['my-password-typed-here', 'Client wants', 'First note', '+91', '@'])
      expect(text).not.toContain(secret);
    expect(all).toContainEqual(
      expect.objectContaining({ action: 'sign-in refused', who: 'unknown', ref: 'not a member' }),
    );
    expect(all.filter((r) => r.action === 'hour limit set').map((r) => r.detail)).toEqual([
      'no limit',
      '10 bikes',
    ]);
  });
});
