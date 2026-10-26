import { describe, expect, it } from 'vitest';
import { adSummary, type AdView } from '../../lib/ads';

const ad = (x: Partial<AdView>): AdView => ({
  adId: 'AD-1',
  name: 'Offer',
  kind: 'mp4',
  width: 1280,
  height: 720,
  durationMs: 15_000,
  checks: [],
  outcome: 'pass',
  preview: '',
  ...x,
});

describe('ads on the admin site (P3.9.1)', () => {
  it('one line: passes, needs a look, or cannot run (and why)', () => {
    expect(adSummary(ad({}))).toBe('Video 1280 × 720, 15.0 s: passes the checks');
    expect(
      adSummary(
        ad({
          kind: 'png',
          durationMs: null,
          checks: [{ check: 'shape', outcome: 'warn', detail: 'shape 2.00 : 1' }],
        }),
      ),
    ).toBe('Picture 1280 × 720: passes, check by eye: shape 2.00 : 1');
    expect(
      adSummary(
        ad({
          durationMs: 3_000,
          checks: [{ check: 'length', outcome: 'fail', detail: '3.0 s: a video must last 15 s' }],
        }),
      ),
    ).toBe('Video 1280 × 720, 3.0 s: cannot run: 3.0 s: a video must last 15 s');
  });
});
