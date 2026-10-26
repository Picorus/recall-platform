import { describe, expect, it } from 'vitest';
import { REVIEW_CHECKLIST } from '@recall/domain';
import { adSummary, reviewText, type AdView } from '../../lib/ads';
import { CHECKLIST, dueText } from '../../lib/reviews';

const ad = (x: Partial<AdView>): AdView => ({
  adId: 'AD-1',
  name: 'Offer',
  kind: 'mp4',
  width: 1280,
  height: 640,
  durationMs: 15_000,
  checks: [],
  outcome: 'pass',
  preview: '',
  review: null,
  ...x,
});

describe('ads on the admin site (P3.9.1)', () => {
  it('one line: passes, needs a look, or cannot run (and why)', () => {
    expect(adSummary(ad({}))).toBe('Video 1280 × 640, 15.0 s: passes the checks');
    expect(
      adSummary(
        ad({
          kind: 'png',
          durationMs: null,
          checks: [{ check: 'shape', outcome: 'warn', detail: 'shape 2.00 : 1' }],
        }),
      ),
    ).toBe('Picture 1280 × 640: passes, check by eye: shape 2.00 : 1');
    expect(
      adSummary(
        ad({
          durationMs: 3_000,
          checks: [{ check: 'length', outcome: 'fail', detail: '3.0 s: a video must last 15 s' }],
        }),
      ),
    ).toBe('Video 1280 × 640, 3.0 s: cannot run: 3.0 s: a video must last 15 s');
  });

  it('review status in words; how urgent; the same checklist as the rules (P3.9.2)', () => {
    expect(reviewText(ad({}))).toBe('Waiting for review');
    expect(
      reviewText(ad({ review: { decision: 'approved', reason: null, by: 'Ravi (s1)', at: 0 } })),
    ).toBe('Approved by Ravi');
    expect(
      reviewText(
        ad({
          review: { decision: 'rejected', reason: 'Looks like a stop sign', by: 'Ravi', at: 0 },
        }),
      ),
    ).toBe('Rejected by Ravi: Looks like a stop sign');
    expect(reviewText(ad({ outcome: 'fail' }))).toBe('Cannot run');
    expect(dueText(null, 0)).toBe('no booking yet');
    expect(dueText(3 * 86_400 + 5, 0)).toBe('due in 3 days');
    expect(dueText(5 * 3600, 0)).toBe('due in 5 hours');
    expect(dueText(0, 2 * 86_400)).toBe('2 days past the deadline');
    expect(CHECKLIST).toEqual(REVIEW_CHECKLIST);
  });
});
