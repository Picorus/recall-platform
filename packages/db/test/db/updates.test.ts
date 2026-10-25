// P2.13: releases, which screens are offered an update, and the rollout moving on or rolling back.
import {
  DEFAULT_ROLLOUT_RULES,
  inStage,
  type ApkFile,
  type HealthReport,
  type Numbered,
  type RolloutRules,
} from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { storeUpload } from '../../src/screen-reports.js';
import { addRelease, driveRollout, rolloutStatus, updateFor } from '../../src/updates.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

const T = Date.UTC(2027, 7, 23, 4, 30); // ms
const HOUR = 3_600_000;
const apk = (code: number): ApkFile => ({
  versionCode: code,
  versionName: `0.${code}.0`,
  sha256: code.toString(16).padStart(64, '0'),
  bytes: 20_000_000,
  url: `https://files.recall.example/player/${code}.apk`,
});
// Quick rules for the test: an hour's hold, half a screen-hour to judge.
const RULES: RolloutRules = { ...DEFAULT_ROLLOUT_RULES, holdMs: HOUR, minScreenHours: 0.5 };

const health = (t: number, appCode: number, crashes: number): HealthReport => ({
  kind: 'health',
  t,
  app: `0.${appCode}.0`,
  upS: 60,
  batteryPct: 80,
  charging: false,
  batteryC: 30,
  boxC: 40,
  freeMb: 9_000,
  signalDbm: -80,
  ledFault: null,
  tamper: null,
  clockDisagree: false,
  spotsNotCounted: 0,
  playsNotStored: 0,
  messagesRefused: 0,
  gpsMissedSeconds: 0,
  adsMissing: 0,
  appCode,
  crashes,
});

/** A screen reporting each minute from `fromMs` for `minutes`, crashing `crashEvery` minutes (0: never). */
async function report(
  screen: string,
  fromMs: number,
  minutes: number,
  appCode: number,
  crashEvery = 0,
  seq0 = 1,
) {
  const t0 = Math.floor(fromMs / 60_000) * 60;
  const batch: Numbered[] = Array.from({ length: minutes }, (_, i) => ({
    seq: seq0 + i,
    at: t0 + i * 60,
    report: health(t0 + i * 60, appCode, crashEvery ? Math.floor(i / crashEvery) : 0),
  }));
  await storeUpload(pool, screen, batch, seq0, t0 + minutes * 60);
}

describe('player updates (P2.13)', () => {
  const screens = Array.from({ length: 400 }, (_, i) => `SCR-${String(i).padStart(7, '0')}A`);

  it('a release goes to its first stage only, and never to a screen already on it or newer', async () => {
    await addRelease(
      pool,
      { id: 'rel-11', apk: apk(110), rollback: apk(111) },
      'ops-1',
      'GPS fixes',
      T,
    );
    const offered = [];
    for (const s of screens) if (await updateFor(pool, s, 100, T, RULES)) offered.push(s);
    expect(offered).toEqual(screens.filter((s) => inStage(s, 'rel-11', 100)));
    expect(offered.length).toBeGreaterThan(0);
    const first = offered[0] as string;
    expect(JSON.parse((await updateFor(pool, first, 100, T, RULES)) as string)).toMatchObject({
      versionCode: 110,
    });
    expect(await updateFor(pool, first, 110, T, RULES)).toBeUndefined();
    expect(await updateFor(pool, first, null, T, RULES)).toBeUndefined();
    await expect(
      addRelease(pool, { id: 'rel-x', apk: apk(111), rollback: apk(112) }, 'ops-1', '', T),
    ).rejects.toThrow('numbered above');
  });

  it('holds, then moves on when the stage has run quietly', async () => {
    expect(await driveRollout(pool, T + 10 * 60_000, RULES)).toMatch(/^hold/);
    // Two screens on the new version, one on the old, an hour without crashes.
    await report('SCR-NEW0001', T, 60, 110);
    await report('SCR-NEW0002', T, 60, 110);
    await report('SCR-OLD0001', T, 60, 100);
    expect(await driveRollout(pool, T + HOUR + 60_000, RULES)).toBe('advance');
    expect(await rolloutStatus(pool)).toMatchObject({
      releaseId: 'rel-11',
      state: 'advanced',
      stage: 1,
    });
  });

  it('rolls back by itself when crashes rise, and offers the rollback build to screens on it', async () => {
    // Stage 2 begins; the new version now crashes every 5 minutes.
    await report('SCR-NEW0001', T + HOUR + 2 * 60_000, 30, 110, 5, 1_000);
    const step = await driveRollout(pool, T + HOUR + 33 * 60_000, RULES);
    expect(step).toBe('roll-back');
    expect(await rolloutStatus(pool)).toMatchObject({ state: 'rolled-back' });
    expect(
      JSON.parse((await updateFor(pool, 'SCR-NEW0001', 110, T, RULES)) as string),
    ).toMatchObject({ versionCode: 111 });
    expect(await updateFor(pool, 'SCR-OLD0001', 100, T, RULES)).toBeUndefined();
    expect(await updateFor(pool, 'SCR-NEW0001', 111, T, RULES)).toBeUndefined();
    expect(await driveRollout(pool, T + 2 * HOUR, RULES)).toBeUndefined(); // nothing running
  });
});
