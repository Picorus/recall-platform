// P2.13: rollout stages, automatic rollback, and the update message.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  DEFAULT_ROLLOUT_RULES,
  inStage,
  nextStep,
  releaseProblem,
  updateProblem,
  updateText,
  type ApkFile,
} from '../src/updates.js';

const HOUR = 3_600_000;
const apk = (code: number): ApkFile => ({
  versionCode: code,
  versionName: `0.${code}.0`,
  sha256: 'a'.repeat(64),
  bytes: 12_345_678,
  url: `https://files.recall.example/player/${code}.apk`,
});
const screens = Array.from({ length: 10_000 }, (_, i) => `SCR-${String(i).padStart(7, '0')}A`);

describe('rollout stages (P2.13)', () => {
  it('1%, then 10%, then all: about the right share, and each stage keeps the screens of the last', () => {
    const share = (bp: number) => screens.filter((s) => inStage(s, 'rel-7', bp)).length;
    expect(share(100)).toBeGreaterThan(70);
    expect(share(100)).toBeLessThan(130);
    expect(share(1_000)).toBeGreaterThan(900);
    expect(share(1_000)).toBeLessThan(1_100);
    expect(share(10_000)).toBe(10_000);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999 }), (i) => {
        const s = screens[i] as string;
        // A screen in the 1% stays in at 10% and 100%: nobody is taken back off.
        return (
          !inStage(s, 'rel-7', 100) || (inStage(s, 'rel-7', 1_000) && inStage(s, 'rel-7', 10_000))
        );
      }),
    );
  });

  it('a different 1% for each release, the same 1% every time for one release', () => {
    const first = screens.filter((s) => inStage(s, 'rel-7', 100));
    const again = screens.filter((s) => inStage(s, 'rel-7', 100));
    const other = screens.filter((s) => inStage(s, 'rel-8', 100));
    expect(again).toEqual(first);
    expect(other.filter((s) => first.includes(s)).length).toBeLessThan(10);
    expect(bucketOf('SCR-0000001A', 'rel-7')).toBeLessThan(10_000);
  });
});

describe('when the rollout moves on, waits, or rolls back', () => {
  const base = {
    stage: 0,
    stageSince: 0,
    now: 25 * HOUR,
    old: { screenHours: 1_000, crashes: 10 },
  };
  it('advances after the hold with enough screen-hours and few crashes', () => {
    expect(nextStep({ ...base, fresh: { screenHours: 40, crashes: 0 } })).toEqual({
      do: 'advance',
      toStage: 1,
    });
    expect(nextStep({ ...base, now: 2 * HOUR, fresh: { screenHours: 40, crashes: 0 } }).do).toBe(
      'hold',
    );
    expect(nextStep({ ...base, fresh: { screenHours: 5, crashes: 0 } }).do).toBe('hold');
    expect(nextStep({ ...base, stage: 2, fresh: { screenHours: 900, crashes: 5 } })).toEqual({
      do: 'finished',
    });
  });

  it('rolls back on crashes, at once when they are many', () => {
    expect(nextStep({ ...base, fresh: { screenHours: 40, crashes: 3 } }).do).toBe('roll-back'); // 0.075/h
    expect(nextStep({ ...base, now: HOUR, fresh: { screenHours: 2, crashes: 3 } }).do).toBe(
      'roll-back',
    );
    expect(nextStep({ ...base, now: HOUR, fresh: { screenHours: 2, crashes: 1 } }).do).toBe('hold'); // chance
    // Twice the old version's rate (old 0.01/h): rolls back even under the plain limit.
    expect(nextStep({ ...base, fresh: { screenHours: 100, crashes: 3 } }).do).toBe('roll-back');
    expect(nextStep({ ...base, fresh: { screenHours: 100, crashes: 2 } }).do).toBe('advance');
  });

  it('never advances once crashes are rising, whatever the hold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 10_000 }),
        fc.integer({ min: 0, max: 2 }),
        (hours, stage) => {
          const crashes = Math.ceil(hours * DEFAULT_ROLLOUT_RULES.maxCrashRate) + 1;
          return (
            nextStep({ ...base, stage, fresh: { screenHours: hours, crashes } }).do === 'roll-back'
          );
        },
      ),
    );
  });
});

describe('the update message', () => {
  it('reads back what it writes and refuses the rest', () => {
    const text = updateText(apk(12), 1_793_620_000_000);
    expect(updateProblem(JSON.parse(text))).toBeUndefined();
    const bad = (o: object) => updateProblem({ ...JSON.parse(text), ...o });
    expect(bad({ url: 'http://files.recall.example/x.apk' })).toBe('bad link');
    expect(bad({ sha256: 'A'.repeat(64) })).toBe('bad fingerprint');
    expect(bad({ bytes: 0 })).toBe('bad size');
    expect(bad({ versionCode: 0 })).toBe('bad version code');
    expect(bad({ extra: 1 })).toBe('not an update');
  });

  it('a release needs a rollback build numbered above it', () => {
    expect(releaseProblem({ id: 'rel-12', apk: apk(120), rollback: apk(121) })).toBeUndefined();
    expect(releaseProblem({ id: 'rel-12', apk: apk(120), rollback: apk(119) })).toMatch(/rollback/);
  });
});
