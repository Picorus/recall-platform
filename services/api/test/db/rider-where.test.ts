// P4.4–P4.5 over HTTP: the days a rider picks (refused when wrong, in the future, too long or too
// old) and "where am I" (his own screen's position and route, a bounded map). Each rider sees only
// his own: the other rider's hours and positions never come back.
import { freshDatabase } from '@recall/db/test-db';
import { fakeMaps, fakeMessages } from '@recall/adapters';
import { assignScreen, createRider, savePriceBook } from '@recall/db';
import { PRICE_BOOK_V1, todayOf } from '@recall/domain';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHandler, type StaffApiConfig } from '../../src/staff-api.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
let server: Server;
let url = '';
const NOW = Date.UTC(2027, 7, 23, 9, 30); // 23 Aug 2027, 15:00 India time (milliseconds)
const now = NOW / 1000;
const today = todayOf(now);
const opens = Date.parse(`${today}T02:30:00Z`) / 1000;
const messages = fakeMessages();
const CFG: StaffApiConfig = {
  secretKey: randomBytes(32),
  origins: ['https://admin.test'],
  secureCookies: true,
  proxyHops: 0,
  messages,
  maps: fakeMaps(),
};

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await savePriceBook(pool, PRICE_BOOK_V1, 'prateek');
  server = createServer(
    apiHandler(
      pool,
      CFG,
      () => {},
      () => NOW,
    ),
  );
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
  await db.drop();
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await r.json()) as Record<string, unknown>;
};

/** A rider on a screen, signed in: his bearer header. */
async function riderOn(name: string, phone: string, screen: string) {
  const riderId = await createRider(
    pool,
    {
      details: { name, phone: `+91${phone}`, bikePlate: null, rides: '', apps: [] },
      channel: 'admin',
      by: 'Omar',
      reason: 'walk-in',
    },
    now - 30 * 86_400,
  );
  await assignScreen(pool, screen, riderId, now - 20 * 86_400, 'fitter');
  await post('/rider/code', { phone, channel: 'whatsapp' });
  const m = messages.sent.at(-1);
  const code = m?.channel === 'whatsapp' ? (m.params[0] ?? '') : '';
  const ok = await post('/rider/sign-in', { phone, code });
  return { riderId, auth: { authorization: `Bearer ${String(ok.token)}` } };
}

/** 2 hours moving then 1 standing (screen on) from 08:00 today, and live positions from 08:00. */
async function rideToday(screen: string, lat: number, lng: number) {
  await pool.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
    screen,
  ]);
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, body)
     SELECT $1, g, 'minute', to_timestamp($2 + (g - 1) * 60), '{}'::jsonb
       FROM generate_series(1, 180) g`,
    [screen, opens],
  );
  await pool.query(
    `INSERT INTO minute_summaries (screen_id, minute, seq, clock_s, pay_clock_s, moving_s,
       distance_m, plays, people, seconds_at, clock_at)
     SELECT $1, to_timestamp($2 + (g - 1) * 60), g, c, c, c, 400, 0, 0, '{"outside":60}',
            jsonb_build_object('inside:hyd-madhapur@1', c)
       FROM (SELECT g, CASE WHEN g <= 120 THEN 60 ELSE 0 END AS c
               FROM generate_series(1, 180) g) x`,
    [screen, opens],
  );
  await pool.query(
    `INSERT INTO screen_reports (screen_id, seq, kind, made_at, received_at, body)
     SELECT $1, 1000 + g, 'live', to_timestamp($2::bigint + g * 30), to_timestamp($2::bigint + g * 30),
            jsonb_build_object('lat', $3::float8 + g * 0.000005, 'lng', $4::float8, 'moving', true)
       FROM generate_series(1, (($5::bigint - $2::bigint) / 30)::int - 1) g`,
    [screen, opens, lat, lng, now],
  );
}

describe('days he picks and where he is, over HTTP (P4.4–P4.5)', () => {
  it('his own hours and positions only; bad picks refused; a bounded map', async () => {
    const ravi = await riderOn('Ravi Kumar', '9848055501', 'scr-api-1');
    const sita = await riderOn('Sita Devi', '9848055502', 'scr-api-2');
    await rideToday('scr-api-1', 17.4483, 78.3915);
    const get = async (path: string, auth: Record<string, string>) => {
      const r = await fetch(`${url}${path}`, { headers: auth });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };

    // Days he picks.
    const week = await get(`/rider/earnings/range?from=2027-08-16&to=${today}`, ravi.auth);
    expect(week.status).toBe(200);
    expect(week.body).toMatchObject({
      from: '2027-08-16',
      to: today,
      countedSeconds: 2 * 3600,
      screenOnSeconds: 3 * 3600,
      earnedPaise: 5_000,
    });
    expect((week.body.days as unknown[]).length).toBe(8);
    // Sita rode nothing: none of Ravi's hours are hers.
    expect(
      (await get(`/rider/earnings/range?from=2027-08-16&to=${today}`, sita.auth)).body,
    ).toMatchObject({ countedSeconds: 0, screenOnSeconds: 0, earnedPaise: 0 });
    // Today's page: screen on beside moving.
    expect((await get('/rider/today', ravi.auth)).body).toMatchObject({
      today: { countedSeconds: 2 * 3600, screenOnSeconds: 3 * 3600 },
    });
    // Refused picks, each with its reason code.
    for (const [q, why] of [
      ['from=2027-08-20&to=2027-08-24', 'range-future'],
      ['from=2027-08-20&to=2027-08-19', 'range-backwards'],
      ['from=2027-05-01&to=2027-08-20', 'range-too-long'],
      ['from=2025-01-01&to=2025-01-10', 'range-too-old'],
      ['from=2027-02-30&to=2027-03-01', 'range-bad-date'],
      ['from=yesterday&to=today', 'range-bad-date'],
      ['to=2027-08-20', 'range-bad-date'],
    ] as const)
      expect(await get(`/rider/earnings/range?${q}`, ravi.auth), q).toMatchObject({
        status: 400,
        body: { why },
      });
    // Signed out: nothing.
    expect((await get(`/rider/earnings/range?from=${today}&to=${today}`, {})).status).toBe(401);
    expect((await get('/rider/where', {})).status).toBe(401);

    // Where he is: his screen's last position, the street, his route, the roads around him.
    const where = await get('/rider/where', ravi.auth);
    expect(where.status).toBe(200);
    expect(where.body).toMatchObject({
      position: { moving: true, age: 'live' },
      street: 'Madhapur Main Road',
      radiusM: 1000,
    });
    const route = where.body.route as [number, number][];
    expect(route.length).toBeGreaterThan(100);
    expect(route.length).toBeLessThanOrEqual(400);
    const roads = where.body.roads as { points: unknown[] }[];
    expect(roads.length).toBeGreaterThan(5);
    expect(roads.reduce((n, r) => n + r.points.length, 0)).toBeLessThanOrEqual(5000);
    expect(JSON.stringify(where.body).length).toBeLessThan(60_000);
    // Without roads (the phone has them).
    expect((await get('/rider/where?roads=no', ravi.auth)).body).toMatchObject({ roads: null });
    // Sita's screen sent nothing: she never gets Ravi's position.
    expect((await get('/rider/where', sita.auth)).body).toMatchObject({
      position: null,
      route: [],
      centre: null,
      roads: null,
    });
  });
});
