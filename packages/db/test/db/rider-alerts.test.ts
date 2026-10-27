// P4.10: alerts to riders: made once each (payout paid, screen silent in business hours, battery
// low, repair booked), sent to his signed-in phones in his language, held while his bike moves,
// never older than a day, never to a phone that left; and listed for the app.
import { fakeDeviceCa, fakeMessages, fakePush } from '@recall/adapters';
import { DEFAULT_RIDER_SIGN_IN as R } from '@recall/domain';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  makeRiderAlerts,
  registerPush,
  riderAlerts,
  sendRiderAlerts,
} from '../../src/rider-alerts.js';
import { askRiderCode, checkRiderCode, riderSession } from '../../src/rider-sign-in.js';
import { createRider } from '../../src/riders.js';
import { enrolScreen, fitScreen, swapScreen } from '../../src/screens.js';
import { boxRequest, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const SECRET = Buffer.alloc(32, 7);
const messages = fakeMessages();
// Tuesday 24 Aug 2027, 15:00 India time (business hours).
const NOW = Date.UTC(2027, 7, 24, 9, 30) / 1000;
const phone = '+919811177001';
let riderId = '';
let screenId = '';
let tokenHash = '';

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  riderId = await createRider(
    pool,
    {
      details: { name: 'Ravi Kumar', phone, bikePlate: 'TS09EA7001', rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    NOW - 9 * 86_400,
  );
  await pool.query(
    `INSERT INTO rider_steps (rider_id, seq, status, reason, by_who, at) VALUES
       ($1, 2, 'approved', 'all checked', 'Omar', to_timestamp($2)),
       ($1, 3, 'active', 'screen fitted', 'Omar', to_timestamp($2 + 7200))`,
    [riderId, NOW - 8 * 86_400],
  );
  const box = await enrolScreen(
    pool,
    fakeDeviceCa(),
    boxRequest('RK-ALERT', NOW - 9 * 86_400),
    'w',
    NOW - 9 * 86_400,
  );
  screenId = box.screenId;
  await fitScreen(
    pool,
    { qr: box.qr, plate: 'TS09EA7001', riderId },
    'Omar',
    NOW - 8 * 86_400 + 3600,
  );
  // Signed in on his phone, which registered for notifications in Telugu.
  await askRiderCode(
    pool,
    messages,
    { phone, channel: 'whatsapp', ip: '10.9.0.1', language: 'te' },
    SECRET,
    NOW - 86_400,
  );
  const m = messages.sent.at(-1);
  const code = m?.channel === 'whatsapp' ? (m.params[0] ?? '') : '';
  const { token } = await checkRiderCode(
    pool,
    { phone, code, ip: '10.9.0.1' },
    SECRET,
    NOW - 86_400,
  );
  const s = await riderSession(pool, token, NOW - 86_400);
  tokenHash = s?.tokenHash ?? '';
  await registerPush(pool, tokenHash, 'ExponentPushToken[abc123xyz]', 'te', NOW - 86_400);
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screenId,
  ]);
}, 60_000);
afterAll(async () => db.drop());

/** A report from his screen, received when it was made. */
async function report(seq: number, kind: 'live' | 'health', at: number, body: object) {
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, received_at, body)
     VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($4), $5)`,
    [screenId, seq, kind, at, JSON.stringify(body)],
  );
}

describe('rider alerts (P4.10)', () => {
  it('a silent screen and a low battery: one alert each, in his language, held while he rides', async () => {
    // Heard from 40 minutes ago, moving, battery 15% not charging.
    const t = NOW - 40 * 60;
    await report(1, 'live', t, { lat: 17.44, lng: 78.38, moving: true });
    await report(2, 'health', t, {});
    await pool.query(
      `INSERT INTO screen_health (screen_id, t, seq, app, up_s, battery_pct, charging, free_mb,
         signal_dbm, clock_disagree, spots_not_counted, plays_not_stored, messages_refused,
         gps_missed_seconds, ads_missing)
       VALUES ($1, to_timestamp($2), 2, '1.0.0', 100, 15, false, 900, -90, false, 0, 0, 0, 0, 0)`,
      [screenId, Math.floor(t / 60) * 60],
    );
    // The battery report is 40 minutes old (within the hour): low battery; silent 40 minutes.
    expect(await makeRiderAlerts(pool, NOW, R)).toBe(2);
    expect(await makeRiderAlerts(pool, NOW + 60, R)).toBe(0);
    const push = fakePush();
    expect(await sendRiderAlerts(pool, push, NOW)).toEqual({ sent: 2, held: 0, failed: 0 });
    expect(push.sent.map((p) => p.title).sort()).toEqual([
      'బ్యాటరీ తక్కువ',
      'మీ స్క్రీన్ నుండి సమాచారం లేదు',
    ]);
    expect(push.sent.find((p) => p.title === 'బ్యాటరీ తక్కువ')?.body).toContain('15%');
    // Sent once.
    expect(await sendRiderAlerts(pool, push, NOW + 120)).toEqual({ sent: 0, held: 0, failed: 0 });
    expect((await riderAlerts(pool, riderId)).map((a) => a.kind).sort()).toEqual([
      'battery-low',
      'screen-offline',
    ]);
  });

  it('his payout paid and a repair booked; held while moving; then sent when he stops', async () => {
    await pool.query(
      `INSERT INTO payout_runs (run_id, prepared_at, prepared_by) VALUES ('2027-08-23', to_timestamp($1), 'system')`,
      [NOW - 3600],
    );
    await pool.query(
      `INSERT INTO payout_lines (run_id, rider_id, amount_paise, destination) VALUES ('2027-08-23', $1, 123450, '{}')`,
      [riderId],
    );
    await pool.query(
      `INSERT INTO payout_attempts (run_id, rider_id, attempt, status, at) VALUES ('2027-08-23', $1, 1, 'paid', to_timestamp($2))`,
      [riderId, NOW + 300],
    );
    // Support swaps his cracked screen for a spare: the old one goes to repair.
    const spare = await enrolScreen(pool, fakeDeviceCa(), boxRequest('RK-SPARE', NOW), 'w', NOW);
    await swapScreen(pool, {
      oldScreenId: screenId,
      newScreenId: spare.screenId,
      reason: 'cracked corner',
      by: 'Sara',
      now: NOW + 310,
    });
    screenId = spare.screenId;
    await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      screenId,
    ]);
    // He is riding right now.
    await report(1, 'live', NOW + 590, { lat: 17.45, lng: 78.39, moving: true });
    expect(await makeRiderAlerts(pool, NOW + 600, R)).toBe(2);
    const push = fakePush();
    expect(await sendRiderAlerts(pool, push, NOW + 600)).toEqual({ sent: 0, held: 2, failed: 0 });
    // Stopped.
    await report(2, 'live', NOW + 900, { lat: 17.45, lng: 78.39, moving: false });
    expect(await sendRiderAlerts(pool, push, NOW + 960)).toEqual({ sent: 2, held: 0, failed: 0 });
    expect(push.sent.find((p) => p.title === 'చెల్లింపు పంపాం')?.body).toContain('₹1,234.50');
  });

  it('a phone that left is not tried again; a signed-out phone gets nothing; old alerts are not sent', async () => {
    await registerPush(pool, tokenHash, 'gone-phone-token-1', 'en', NOW + 1000);
    await pool.query(
      `INSERT INTO rider_alerts (alert_id, rider_id, kind, ref, vals, at)
       VALUES ('ALR-000000000001', $1, 'repair-booked', 'service:test', '{}', to_timestamp($2))`,
      [riderId, NOW + 1010],
    );
    const push = fakePush();
    const r = await sendRiderAlerts(pool, push, NOW + 1020);
    expect(r.sent).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
    expect((await sendRiderAlerts(pool, push, NOW + 1030)).failed).toBe(0);
    // An alert older than a day is never sent.
    await registerPush(pool, tokenHash, 'ExponentPushToken[new456]', 'en', NOW + 2000);
    expect((await sendRiderAlerts(pool, push, NOW + 2 * 86_400)).sent).toBe(0);
    await expect(registerPush(pool, tokenHash, 'x', 'en', NOW)).rejects.toThrow('Not a push token');
  });

  it('no morning alert for a night off; quiet at night; 3 failures and it stops; a handset passed on', async () => {
    const push = fakePush();
    // Wednesday 07:59 India time: the screen was last heard at 01:30 (the night before).
    const wed = Date.UTC(2027, 7, 25, 2, 29) / 1000;
    await report(3, 'live', Date.UTC(2027, 7, 24, 20, 0) / 1000, { lat: 1, lng: 1, moving: false });
    const before = (await riderAlerts(pool, riderId)).length;
    await makeRiderAlerts(pool, wed + 3 * 3600, R);
    // Nothing new: last heard before today's business day opened.
    expect((await riderAlerts(pool, riderId)).length).toBe(before);
    // An alert made at 23:00 India time waits for the morning.
    await registerPush(pool, tokenHash, 'ExponentPushToken[night1]', 'en', wed - 9 * 3600);
    const night = Date.UTC(2027, 7, 24, 17, 30) / 1000;
    await pool.query(
      `INSERT INTO rider_alerts (alert_id, rider_id, kind, ref, vals, at)
       VALUES ('ALR-0000000000A1', $1, 'repair-booked', 'service:night', '{}', to_timestamp($2))`,
      [riderId, night],
    );
    expect((await sendRiderAlerts(pool, push, night + 60, R)).held).toBeGreaterThan(0);
    expect(push.sent).toHaveLength(0);
    // A provider that keeps failing: tried 3 times, then left.
    const failing = { send: () => Promise.resolve({ status: 'failed' as const, reason: 'down' }) };
    const morning = Date.UTC(2027, 7, 25, 3, 0) / 1000;
    for (let i = 0; i < 4; i++) await sendRiderAlerts(pool, failing, morning + i * 120, R);
    const tries = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM rider_alert_pushes WHERE alert_id = 'ALR-0000000000A1'
          AND push_token = 'ExponentPushToken[night1]'`,
    );
    expect(tries.rows[0]?.n).toBe(3);
    // His handset goes to another rider who signs in on it: only the new owner is reached.
    const other = '+919811177002';
    const otherId = await createRider(
      pool,
      {
        details: { name: 'Mohan', phone: other, bikePlate: null, rides: '', apps: [] },
        channel: 'admin',
        by: 'Omar',
        reason: 'walk-in',
      },
      morning - 3600,
    );
    await askRiderCode(
      pool,
      messages,
      { phone: other, channel: 'whatsapp', ip: '10.9.0.2', language: 'en' },
      SECRET,
      morning,
    );
    const m = messages.sent.at(-1);
    const code = m?.channel === 'whatsapp' ? (m.params[0] ?? '') : '';
    const { token } = await checkRiderCode(
      pool,
      { phone: other, code, ip: '10.9.0.2' },
      SECRET,
      morning,
    );
    const theirs = await riderSession(pool, token, morning);
    await registerPush(
      pool,
      theirs?.tokenHash ?? '',
      'ExponentPushToken[night1]',
      'en',
      morning + 600,
    );
    await pool.query(
      `INSERT INTO rider_alerts (alert_id, rider_id, kind, ref, vals, at)
       VALUES ('ALR-0000000000A2', $1, 'repair-booked', 'service:old-owner', '{}', to_timestamp($2))`,
      [riderId, morning + 700],
    );
    const fresh = fakePush();
    await sendRiderAlerts(pool, fresh, morning + 800, R);
    expect(fresh.sent.filter((p) => p.key.startsWith('ALR-0000000000A2'))).toEqual([]);
    expect(otherId).toMatch(/^RD-/);
  });
});
