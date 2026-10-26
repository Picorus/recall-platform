// P3.3: the fleet map's records: every screen with its state, last position, bike and alerts; one
// screen's route, health, fittings and commands; commands just issued, for the gateway to send.
import { newScreenId, parseCommand, type Numbered } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { issueCommand } from '../../src/commands.js';
import { fleetScreens, freshCommands, screenDetail } from '../../src/fleet.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
// Real time: "heard from" uses the database's own receive time.
const NOW = Math.floor(Date.now() / 1000);
const [A, B, C] = [0, 1, 2].map((i) => newScreenId([i, 9, 9, 1, 2, 3, 4])) as [
  string,
  string,
  string,
];

const live = (seq: number, t: number, lat: number, moving: boolean): Numbered => ({
  seq,
  at: t,
  report: { kind: 'live', t, lat, lng: 78.39, place: 'inside:hyd-madhapur@1', moving },
});

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  for (const [i, id] of [A, B, C].entries())
    await pool.query(
      `INSERT INTO screens (screen_id, hardware_serial, model, enrolled_by, enrolled_at)
       VALUES ($1, $2, 'VendorX LED28 v1', 'warehouse-1', to_timestamp($3))`,
      [id, `RK-FLEET-${i}`, NOW - 86_400],
    );
  await pool.query(
    `INSERT INTO screen_fittings (screen_id, from_at, bike, rider_id, reason, set_by) VALUES
       ($1, to_timestamp($3), 'TS09EA0001', 'R-1', 'first fitting', 'fitter'),
       ($2, to_timestamp($3), 'TS09EA0002', 'R-2', 'first fitting', 'fitter')`,
    [A, B, NOW - 7200],
  );
  // A drove for an hour: a position every 5 minutes, moving; the latest 30 s ago.
  await storeUpload(
    pool,
    A,
    Array.from({ length: 12 }, (_, i) =>
      live(i + 1, NOW - 3600 + i * 300 + 270, 17.44 + i * 0.001, true),
    ),
    1,
    NOW,
  );
  // B sent one position yesterday morning (shown) and nothing since.
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1)', [B]);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, received_at, body)
     VALUES ($1, 1, 'live', to_timestamp($2), to_timestamp($2), $3)`,
    [
      B,
      NOW - 20 * 3600,
      JSON.stringify({
        kind: 'live',
        t: NOW - 20 * 3600,
        lat: 17.45,
        lng: 78.38,
        place: 'outside',
        moving: false,
      }),
    ],
  );
  await pool.query(
    `INSERT INTO screen_alert_events (screen_id, kind, state, at) VALUES
       ($1, 'no-contact', 'raised', to_timestamp($2)), ($1, 'low-battery', 'raised', to_timestamp($2))`,
    [B, NOW - 19 * 3600],
  );
}, 120_000);
afterAll(async () => db.drop());

describe('the fleet map (P3.3)', () => {
  it('every screen: state, last position (only from the screen), bike and open alerts', async () => {
    const all = await fleetScreens(pool, NOW);
    expect(all.map((s) => [s.bike, s.state])).toEqual([
      ['TS09EA0001', 'moving'],
      ['TS09EA0002', 'offline'],
      [null, 'at-hub'],
    ]);
    const [a, b, c] = all;
    expect(a?.position).toMatchObject({
      t: NOW - 30,
      lat: 17.451,
      moving: true,
      place: 'inside:hyd-madhapur@1',
    });
    expect(b?.position).toMatchObject({ lat: 17.45, place: 'outside' });
    expect(b?.alerts).toEqual(['low-battery', 'no-contact']);
    expect(c?.position).toBeNull();
    // A position older than a day is not shown.
    expect(
      (await fleetScreens(pool, NOW + 5 * 3600)).find((s) => s.screenId === B)?.position,
    ).toBeNull();
  });

  it('one screen: its route for the last 2 hours, oldest first, and its fittings', async () => {
    const d = await screenDetail(pool, A, NOW);
    expect(d?.route).toHaveLength(12);
    expect(d?.route[0]?.lat).toBe(17.44);
    expect(d?.route[11]?.lat).toBe(17.451);
    expect(d?.fittings).toEqual([
      { from: NOW - 7200, bike: 'TS09EA0001', riderId: 'R-1', reason: 'first fitting' },
    ]);
    expect(d?.health).toBeNull();
    expect((await screenDetail(pool, A, NOW, 0.25))?.route).toHaveLength(3);
    expect(await screenDetail(pool, newScreenId([5, 5, 5, 5, 5, 5, 5]), NOW)).toBeUndefined();
  });

  it('commands just issued, ready for the gateway; logged on the screen', async () => {
    const nowMs = NOW * 1000;
    const c = await issueCommand(pool, {
      screenId: A,
      command: 'blank',
      value: null,
      by: 'Arjun (STF-1)',
      reason: 'rider asked',
      nowMs,
    });
    const fresh = await freshCommands(pool, nowMs);
    expect(fresh.map((f) => [f.screenId, f.id])).toEqual([[A, c.id]]);
    expect(parseCommand(fresh[0]?.text ?? '')).toMatchObject({ id: c.id, do: 'blank', screen: A });
    // A command made a little before (a slow request, a clock a little behind) is still picked up;
    // after a minute it is left to the screen's next hello.
    expect(await freshCommands(pool, nowMs + 50_000)).toHaveLength(1);
    expect(await freshCommands(pool, nowMs + 61_000)).toEqual([]);
    const d = await screenDetail(pool, A, NOW);
    expect(d?.commands[0]).toMatchObject({
      id: c.id,
      command: 'blank',
      state: 'waiting',
      reason: 'rider asked',
    });
  });

  it('the same command twice within 30 seconds is one command (a double click never restarts twice)', async () => {
    const nowMs = NOW * 1000 + 100_000;
    const o = {
      screenId: B,
      command: 'reboot' as const,
      value: null,
      by: 'Arjun (STF-1)',
      reason: 'frozen',
      nowMs,
      unlessRepeatWithinMs: 30_000,
    };
    const first = await issueCommand(pool, o);
    const again = await issueCommand(pool, { ...o, nowMs: nowMs + 5_000 });
    expect(again).toMatchObject({ id: first.id, repeated: true });
    expect(parseCommand(again.text)).toMatchObject({ id: first.id, do: 'reboot' });
    // Two clicks at the same moment: still one.
    const [x, y] = await Promise.all([
      issueCommand(pool, { ...o, command: 'clear-cache', nowMs: nowMs + 6_000 }),
      issueCommand(pool, { ...o, command: 'clear-cache', nowMs: nowMs + 6_000 }),
    ]);
    expect(x.id).toBe(y.id);
    // A different value, or after 30 seconds, is a new command.
    const b1 = await issueCommand(pool, { ...o, command: 'brightness', value: 40 });
    const b2 = await issueCommand(pool, { ...o, command: 'brightness', value: 60 });
    expect(b2.id).not.toBe(b1.id);
    expect((await issueCommand(pool, { ...o, nowMs: nowMs + 31_000 })).id).not.toBe(first.id);
  });
});
