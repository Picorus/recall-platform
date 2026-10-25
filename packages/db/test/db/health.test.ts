// P2.11: health reports stored, alerts raised and cleared on them, and on silence.
import type { HealthReport, Numbered } from '@recall/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { openAlerts, raiseSilentAlerts } from '../../src/health.js';
import { storeUpload } from '../../src/screen-reports.js';
import { freshDatabase } from './fresh-db.js';

let db: Awaited<ReturnType<typeof freshDatabase>>;
let pool: pg.Pool;
beforeAll(async () => {
  db = await freshDatabase();
  pool = db.pool;
});
afterAll(async () => db.drop());

// Mon 23 Aug 2027, 10:00 India time.
const T = Date.UTC(2027, 7, 23, 4, 30) / 1000;

const healthy = (t: number, o: Partial<HealthReport> = {}): HealthReport => ({
  kind: 'health',
  t,
  app: '0.9.0',
  upS: 600,
  batteryPct: 80,
  charging: false,
  batteryC: 38,
  boxC: 52,
  freeMb: 9_000,
  signalDbm: -85,
  ledFault: null,
  tamper: null,
  clockDisagree: false,
  spotsNotCounted: 0,
  playsNotStored: 0,
  messagesRefused: 0,
  gpsMissedSeconds: 0,
  adsMissing: 0,
  appCode: 9,
  crashes: 0,
  ...o,
});

const kinds = async (screen: string) => (await openAlerts(pool, screen)).map((a) => a.kind).sort();

describe('screen health (P2.11)', () => {
  it('stores each report, raises alerts on problems and clears them when they go', async () => {
    const s = 'SCR-0000101A';
    const up = (seq: number, h: HealthReport, oldest = seq): Promise<unknown> =>
      storeUpload(pool, s, [{ seq, at: h.t, report: h } as Numbered], oldest, T + 3_600);
    await up(1, healthy(T));
    expect(await kinds(s)).toEqual([]);
    await up(2, healthy(T + 60, { boxC: 80, batteryPct: 9, tamper: true, freeMb: 100 }));
    expect(await kinds(s)).toEqual(['low-battery', 'low-storage', 'overheating', 'tamper']);
    // Charging: a low battery is no alarm. The rest stay raised (no second "raised" event).
    await up(
      3,
      healthy(T + 120, { boxC: 80, batteryPct: 9, charging: true, tamper: true, freeMb: 100 }),
    );
    expect(await kinds(s)).toEqual(['low-storage', 'overheating', 'tamper']);
    const events = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM screen_alert_events WHERE screen_id = $1 AND kind = 'tamper'",
      [s],
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
    await up(4, healthy(T + 180));
    expect(await kinds(s)).toEqual([]);
    const rows = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM screen_health WHERE screen_id = $1',
      [s],
    );
    expect(Number(rows.rows[0]?.n)).toBe(4);
  });

  it('a report arriving late is kept but changes no alert', async () => {
    const s = 'SCR-0000102B';
    await storeUpload(
      pool,
      s,
      [{ seq: 2, at: T + 60, report: healthy(T + 60) } as Numbered],
      1,
      T + 3_600,
    );
    // Number 1, older, comes after: it reports overheating that has since passed.
    await storeUpload(
      pool,
      s,
      [{ seq: 1, at: T, report: healthy(T, { boxC: 90 }) } as Numbered],
      1,
      T + 3_600,
    );
    expect(await kinds(s)).toEqual([]);
  });

  it('a bad health report is set aside, never stored as health', async () => {
    const s = 'SCR-0000103C';
    const bad = { ...healthy(T), batteryPct: 140 };
    const r = await storeUpload(
      pool,
      s,
      [{ seq: 1, at: T, report: bad } as Numbered],
      1,
      T + 3_600,
    );
    expect(r.rejected).toBe(1);
    const extra = { ...healthy(T + 60), camera: 'picture' } as unknown as HealthReport;
    const r2 = await storeUpload(
      pool,
      s,
      [{ seq: 2, at: T, report: extra } as Numbered],
      2,
      T + 3_600,
    );
    expect(r2.rejected).toBe(1);
  });

  it('a screen silent for 30 minutes is raised once, and cleared when it is heard again', async () => {
    const s = 'SCR-0000104D';
    await storeUpload(pool, s, [{ seq: 1, at: T, report: healthy(T) } as Numbered], 1, T + 3_600);
    const later = Date.now() + 31 * 60_000;
    expect(await raiseSilentAlerts(pool, Date.now() + 10 * 60_000)).not.toContain(s);
    expect(await raiseSilentAlerts(pool, later)).toContain(s);
    expect(await raiseSilentAlerts(pool, later + 60_000)).not.toContain(s); // once
    expect(await kinds(s)).toEqual(['no-contact']);
    await storeUpload(
      pool,
      s,
      [{ seq: 2, at: T + 60, report: healthy(T + 60) } as Numbered],
      2,
      T + 3_600,
    );
    expect(await kinds(s)).toEqual([]);
  });
});
