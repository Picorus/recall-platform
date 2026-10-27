import { describe, expect, it } from 'vitest';
import { actionsFor, certificateSoon, stageText } from '../../lib/screens';

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
