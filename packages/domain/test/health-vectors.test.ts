// P2.11: shared health cases (test-vectors/health.json): what the box reads and the report it must
// send. Each expected report passes the cloud's own check. Regenerate after a deliberate change with:
//   UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReport } from '../src/screen-reports.js';
import { healthAlerts, type HealthReport } from '../src/screen-health.js';

const FILE = new URL('../test-vectors/health.json', import.meta.url);

const base: HealthReport = {
  kind: 'health',
  t: 1_800_000_060,
  app: '0.9.0',
  upS: 3_725,
  batteryPct: 81,
  charging: false,
  batteryC: 38,
  boxC: 54,
  freeMb: 9_123,
  signalDbm: -87,
  ledFault: null,
  tamper: null,
  clockDisagree: false,
  spotsNotCounted: 3,
  playsNotStored: 0,
  messagesRefused: 1,
  gpsMissedSeconds: 12,
  adsMissing: 2,
  appCode: 10,
  crashes: 1,
};
const cases: { name: string; report: HealthReport }[] = [
  { name: 'a healthy box', report: base },
  {
    name: 'a box with nothing readable yet (no battery link, no modem, no sensors)',
    report: {
      ...base,
      batteryPct: null,
      charging: null,
      batteryC: null,
      boxC: null,
      signalDbm: null,
    },
  },
  {
    name: 'a hot box, low battery, panel fault, opened case',
    report: { ...base, boxC: 81, batteryPct: 7, ledFault: true, tamper: true, clockDisagree: true },
  },
];

describe('shared health cases', () => {
  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE)) writeFileSync(FILE, text);

  it('are up to date', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('every report passes the cloud check, and the alerts are as named', () => {
    for (const c of cases) expect(checkReport(c.report)).toBeUndefined();
    expect([...healthAlerts((cases[0] as (typeof cases)[number]).report)]).toEqual([]);
    expect([...healthAlerts((cases[1] as (typeof cases)[number]).report)]).toEqual([]);
    expect([...healthAlerts((cases[2] as (typeof cases)[number]).report)].sort()).toEqual([
      'led-fault',
      'low-battery',
      'overheating',
      'tamper',
    ]);
  });

  it('refuses made-up or extra values', () => {
    expect(checkReport({ ...base, t: base.t + 1 })).toBe('health must be for a whole minute');
    expect(checkReport({ ...base, batteryPct: 101 })).toBe('bad battery');
    expect(checkReport({ ...base, signalDbm: 5 })).toBe('bad signal');
    expect(checkReport({ ...base, boxC: 20.5 })).toBe('bad temperature');
    expect(checkReport({ ...base, app: 'x y' })).toBe('bad app version');
    expect(checkReport({ ...base, adsMissing: -1 })).toBe('bad counter adsMissing');
    expect(checkReport({ ...base, appCode: 0 })).toBe('bad app version');
    expect(checkReport({ ...base, frame: 'jpeg' })).toBe('unknown field: frame');
  });
});
