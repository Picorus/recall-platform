// P3.4: a screen's life on the Screens page: on a bike, in stock, in repair, retired; swapping a
// bike's screen for a spare; pausing and resuming a player update.
import { fakeDeviceCa } from '@recall/adapters';
import { enrolmentBytes, type ApkFile } from '@recall/domain';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { screenList, stockCounts } from '../../src/screen-list.js';
import {
  enrolScreen,
  fitScreen,
  serviceScreen,
  swapScreen,
  unfitScreen,
} from '../../src/screens.js';
import {
  addRelease,
  driveRollout,
  pauseRollout,
  rollBack,
  rolloutStatus,
  updateFor,
} from '../../src/updates.js';
import { approvedRider, freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
const NOW = Date.UTC(2027, 6, 1, 6) / 1000;
const ca = fakeDeviceCa();
const ids: string[] = [];

async function enrol(serial: string): Promise<string> {
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
  const e = await enrolScreen(
    pool,
    ca,
    {
      ...req,
      tlsSignature: sign('sha256', bytes, tls.privateKey).toString('base64'),
      playSignature: sign('sha256', bytes, play.privateKey).toString('base64'),
    },
    'warehouse-1',
    NOW,
  );
  return e.screenId;
}

beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
  await approvedRider(pool, 'RD-000101', 'TS09EA1111');
  await approvedRider(pool, 'RD-000102', 'TS09EA2222');
  await approvedRider(pool, 'RD-000103', 'TS09EA3333');
  for (const s of ['RK-SVC-A', 'RK-SVC-B', 'RK-SVC-C', 'RK-SVC-D']) ids.push(await enrol(s));
}, 120_000);
afterAll(async () => db.drop());

const life = async (t: number) =>
  Object.fromEntries((await screenList(pool, t)).map((r) => [r.screenId, r.life]));

describe('screens: stock, repairs, swaps (P3.4)', () => {
  it('on a bike, in stock, in repair, retired: each step with why, never a fitted screen', async () => {
    const [a, b, c, d] = ids as [string, string, string, string];
    await fitScreen(
      pool,
      { qr: `RECALL1:${a}`, plate: 'TS09EA1111', riderId: 'RD-000101' },
      'fitter',
      NOW + 10,
    );
    await serviceScreen(pool, {
      screenId: c,
      kind: 'to-repair',
      reason: 'cracked panel',
      by: 'Arjun',
      now: NOW + 20,
    });
    await serviceScreen(pool, {
      screenId: d,
      kind: 'retired',
      reason: 'water damage',
      by: 'Arjun',
      now: NOW + 20,
    });
    expect(await life(NOW + 30)).toEqual({
      [a]: 'on-bike',
      [b]: 'in-stock',
      [c]: 'in-repair',
      [d]: 'retired',
    });
    const rows = await screenList(pool, NOW + 30);
    expect(rows[0]).toMatchObject({
      screenId: a,
      bike: 'TS09EA1111',
      riderId: 'RD-000101',
      state: 'offline',
    });
    expect(rows.find((r) => r.screenId === c)?.serviceNote).toBe('cracked panel');
    expect(stockCounts(rows)).toEqual({
      onBike: 1,
      inStock: 1,
      cannotFit: 0,
      inRepair: 1,
      retired: 1,
      sparesWanted: 1,
    });

    // Refused: a fitted screen to repair; a screen in repair or retired onto a bike; retired again.
    await expect(
      serviceScreen(pool, {
        screenId: a,
        kind: 'to-repair',
        reason: 'flicker',
        by: 'Arjun',
        now: NOW + 40,
      }),
    ).rejects.toThrow('on a bike');
    await expect(
      fitScreen(
        pool,
        { qr: `RECALL1:${c}`, plate: 'TS09EA2222', riderId: 'RD-000102' },
        'fitter',
        NOW + 40,
      ),
    ).rejects.toThrow('in repair');
    await expect(
      fitScreen(
        pool,
        { qr: `RECALL1:${d}`, plate: 'TS09EA2222', riderId: 'RD-000102' },
        'fitter',
        NOW + 40,
      ),
    ).rejects.toThrow('retired');
    await expect(
      serviceScreen(pool, {
        screenId: d,
        kind: 'to-repair',
        reason: 'try again',
        by: 'Arjun',
        now: NOW + 40,
      }),
    ).rejects.toThrow('retired');
    await expect(
      serviceScreen(pool, {
        screenId: b,
        kind: 'repaired',
        reason: 'nothing',
        by: 'Arjun',
        now: NOW + 40,
      }),
    ).rejects.toThrow('not in repair');
  });

  it('a swap: the old screen off and to repair, the spare on the same bike and rider, at once', async () => {
    const [a, b, c] = ids as [string, string, string];
    const f = await swapScreen(pool, {
      oldScreenId: a,
      newScreenId: b,
      reason: 'screen flickers',
      by: 'Arjun',
      now: NOW + 100,
    });
    expect(f).toEqual({ screenId: b, bike: 'TS09EA1111', riderId: 'RD-000101', from: NOW + 100 });
    expect(await life(NOW + 101)).toMatchObject({ [a]: 'in-repair', [b]: 'on-bike' });
    const why = await pool.query<{ reason: string }>(
      'SELECT reason FROM screen_fittings WHERE screen_id = $1 ORDER BY from_at DESC LIMIT 1',
      [a],
    );
    expect(why.rows[0]?.reason).toBe(`swapped for ${b}: screen flickers`);
    // A spare in repair cannot be swapped in; the swap leaves nothing half done.
    await expect(
      swapScreen(pool, {
        oldScreenId: b,
        newScreenId: c,
        reason: 'again',
        by: 'Arjun',
        now: NOW + 200,
      }),
    ).rejects.toThrow('in repair');
    expect(await life(NOW + 201)).toMatchObject({ [b]: 'on-bike', [c]: 'in-repair' });
    // Repaired, it is stock again and can go on a bike.
    await serviceScreen(pool, {
      screenId: c,
      kind: 'repaired',
      reason: 'new panel fitted',
      by: 'Arjun',
      now: NOW + 300,
    });
    await unfitScreen(pool, b, 'rider left', 'Arjun', NOW + 310);
    await fitScreen(
      pool,
      { qr: `RECALL1:${c}`, plate: 'TS09EA3333', riderId: 'RD-000103' },
      'fitter',
      NOW + 320,
    );
    expect(await life(NOW + 330)).toMatchObject({ [b]: 'in-stock', [c]: 'on-bike' });
  });

  it('nothing is edited or deleted', async () => {
    await expect(
      pool.query("UPDATE screen_service_events SET kind = 'repaired'"),
    ).rejects.toThrow();
    await expect(pool.query('DELETE FROM screen_service_events')).rejects.toThrow();
  });
});

describe('pausing a player update (P3.4)', () => {
  const apk = (code: number): ApkFile => ({
    versionCode: code,
    versionName: `0.${code}.0`,
    sha256: code.toString(16).padStart(64, '0'),
    bytes: 20_000_000,
    url: `https://files.recall.example/player/${code}.apk`,
  });
  const T = Date.UTC(2027, 7, 23, 4, 30);

  it('paused: no new screen is offered it and it does not move on; resumed: as before', async () => {
    const fleet = Array.from({ length: 300 }, (_, i) => `SCR-${String(i).padStart(7, '0')}B`);
    for (const s of fleet)
      await pool.query(
        'INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [s],
      );
    await addRelease(
      pool,
      { id: 'rel-20', apk: apk(200), rollback: apk(201) },
      'ci',
      'brightness fix',
      T,
    );
    const offered = async (t: number) => {
      let n = 0;
      for (const s of fleet) if (await updateFor(pool, s, 190, t)) n++;
      return n;
    };
    const before = await offered(T);
    expect(before).toBeGreaterThan(0);
    expect(await pauseRollout(pool, true, 'Arjun', 'riders report flicker', T + 1000)).toBe(true);
    expect(await pauseRollout(pool, true, 'Arjun', 'again', T + 1001)).toBe(false);
    expect(await offered(T + 2000)).toBe(0);
    expect(await driveRollout(pool, T + 48 * 3_600_000)).toBe('hold: paused by staff');
    expect(await rolloutStatus(pool)).toMatchObject({
      state: 'paused',
      stage: 0,
      versionName: '0.200.0',
      rollbackName: '0.201.0',
    });
    expect(await pauseRollout(pool, false, 'Arjun', 'not the update', T + 3000)).toBe(true);
    expect(await offered(T + 4000)).toBe(before);
    // A paused update can still be rolled back.
    await pauseRollout(pool, true, 'Arjun', 'flicker again', T + 5000);
    expect(await rollBack(pool, 'Arjun', 'it was the update', T + 6000)).toBe(true);
    expect(await rolloutStatus(pool)).toMatchObject({ state: 'rolled-back' });
    await expect(pauseRollout(pool, true, 'Arjun', 'x', T)).rejects.toThrow('reason');
  }, 60_000);
});
