import { describe, expect, it } from 'vitest';
import { actionsFor, certificateSoon, screenMatches, stageText } from '../../lib/screens';

describe('Screens page words', () => {
  it('the rollout in words', () => {
    expect(stageText('started', 0)).toBe('going to 1% of screens');
    expect(stageText('advanced', 1)).toBe('going to 10% of screens');
    expect(stageText('paused', 2)).toBe('paused at all screens');
    expect(stageText('finished', 2)).toBe('on all screens');
    expect(stageText('rolled-back', 0)).toBe('rolled back (was at 1% of screens)');
  });

  it('a certificate within 30 days (or none) needs renewing', () => {
    expect(certificateSoon(null, 0)).toBe(true);
    expect(certificateSoon(29 * 86_400, 0)).toBe(true);
    expect(certificateSoon(31 * 86_400, 0)).toBe(false);
  });

  it('what can be done in each part of a screen life', () => {
    expect(actionsFor('on-bike')).toEqual(['swap', 'unfit', 'lost']);
    expect(actionsFor('in-stock')).toEqual(['to-repair', 'retired', 'lost']);
    expect(actionsFor('in-repair')).toEqual(['repaired', 'retired', 'lost']);
    expect(actionsFor('retired')).toEqual([]);
  });
});

describe('the screen search box', () => {
  it('screen id, plate or serial; spaces, dashes and small letters do not count', () => {
    const r = { screenId: 'SCR-7K3M9QX4', bike: 'TS09EA1234', serial: 'RK-0042' };
    for (const q of ['', 'SCR-7K3M', ' scr 7k3m ', '9qx4', 'ts 09 ea', 'TS-09-EA-1234', 'rk 0042'])
      expect(screenMatches(r, q), q).toBe(true);
    for (const q of ['SCR-9', 'KA01', 'rk 0043']) expect(screenMatches(r, q), q).toBe(false);
    expect(screenMatches({ ...r, bike: null }, 'ts09')).toBe(false);
  });
});
