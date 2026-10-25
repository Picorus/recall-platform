// P2.14: the fitting check, and the shared cases the box builds its reports from
// (test-vectors/fitting.json). Regenerate with: UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fittingVerdict, type FittingReport } from '../src/fitting.js';
import { checkReport } from '../src/screen-reports.js';

const FILE = new URL('../test-vectors/fitting.json', import.meta.url);
const good: FittingReport = {
  kind: 'fitting',
  id: 'c-fitting-0001',
  at: 1_793_620_120,
  gpsAccuracyM: 6,
  lineUp: true,
  camera: 'ok',
  batteryPct: 82,
  charging: false,
  panel: 'unknown',
};
const cases: { name: string; report: FittingReport; ready: boolean }[] = [
  { name: 'every part passes', report: good, ready: true },
  { name: 'no GPS fix', report: { ...good, gpsAccuracyM: null }, ready: false },
  { name: 'GPS too rough', report: { ...good, gpsAccuracyM: 51 }, ready: false },
  { name: 'line down', report: { ...good, lineUp: false }, ready: false },
  { name: 'camera not answering', report: { ...good, camera: 'fail' }, ready: false },
  { name: 'camera not known (no link yet)', report: { ...good, camera: 'unknown' }, ready: false },
  { name: 'battery low', report: { ...good, batteryPct: 30 }, ready: false },
  {
    name: 'battery low but charging',
    report: { ...good, batteryPct: 30, charging: true },
    ready: true,
  },
  {
    name: 'battery not readable',
    report: { ...good, batteryPct: null, charging: null },
    ready: false,
  },
];

describe('fitting check (P2.14)', () => {
  const text = `${JSON.stringify({ cases }, null, 2)}\n`;
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE)) writeFileSync(FILE, text);

  it('shared cases are up to date', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(text);
  });

  it('the cloud judges every part itself; a part not known never passes', () => {
    for (const c of cases) {
      expect(checkReport(c.report)).toBeUndefined();
      expect(fittingVerdict(c.report).ready, c.name).toBe(c.ready);
    }
    expect(fittingVerdict({ ...good, camera: 'unknown' }).camera).toBe('unknown');
  });

  it('refuses reports that are not well formed', () => {
    expect(checkReport({ ...good, gpsAccuracyM: 6.5 })).toBe('bad gps');
    expect(checkReport({ ...good, camera: 'maybe' })).toBe('bad part');
    expect(checkReport({ ...good, batteryPct: 101 })).toBe('bad battery');
    expect(checkReport({ ...good, photo: 'x' })).toBe('unknown field: photo');
  });
});
