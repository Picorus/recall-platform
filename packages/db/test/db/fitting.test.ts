// P2.14: fitting checks stored with the cloud's verdict; the latest says whether the bike is ready.
import type { FittingReport, Numbered } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { issueCommand } from '../../src/commands.js';
import { latestFitting } from '../../src/fitting.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

const T = Date.UTC(2027, 7, 23, 4, 30) / 1000;
const SCREEN = 'SCR-1234567M';

describe('fitting check (P2.14)', () => {
  it('a passing check makes the bike ready; a later failing one takes it back', async () => {
    const cmd = await issueCommand(pool, {
      screenId: SCREEN,
      command: 'fitting-check',
      value: 120,
      by: 'tech-7',
      reason: 'fitting at Madhapur hub',
      nowMs: T * 1000,
    });
    expect(JSON.parse(cmd.text)).toMatchObject({ do: 'fitting-check', value: 120 });
    expect(await latestFitting(pool, SCREEN)).toBeUndefined();
    const report = (at: number, o: Partial<FittingReport> = {}): FittingReport => ({
      kind: 'fitting',
      id: cmd.id,
      at,
      gpsAccuracyM: 7,
      lineUp: true,
      camera: 'ok',
      batteryPct: 90,
      charging: true,
      panel: 'unknown',
      ...o,
    });
    const up = (seq: number, r: FittingReport) =>
      storeUpload(pool, SCREEN, [{ seq, at: r.at, report: r } as Numbered], seq, T + 3_600);
    await up(1, report(T + 120));
    expect(await latestFitting(pool, SCREEN)).toMatchObject({
      at: T + 120,
      verdict: { ready: true },
    });
    await up(2, report(T + 900, { camera: 'unknown' }));
    expect(await latestFitting(pool, SCREEN)).toMatchObject({
      verdict: { ready: false, camera: 'unknown', gps: 'ok' },
    });
  });

  it('a fitting check needs its time: commands without one are refused', async () => {
    await expect(
      issueCommand(pool, {
        screenId: SCREEN,
        command: 'fitting-check',
        value: null,
        by: 'tech-7',
        reason: 'fitting',
        nowMs: T * 1000,
      }),
    ).rejects.toThrow('bad value');
  });
});
