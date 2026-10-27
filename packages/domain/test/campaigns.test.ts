import { describe, expect, it } from 'vitest';
import { campaignNote, campaignStage } from '../src/campaigns.js';

const T = 1_000_000;
const first = T + 3600;
const last = T + 7 * 86_400;

describe('my campaigns (P5.3)', () => {
  it('Scheduled, Running or Done by the step and the hours', () => {
    expect(campaignStage('awaiting-payment', T, first, last)).toBe('to-pay');
    expect(campaignStage('draft', T, first, last)).toBe('to-pay');
    expect(campaignStage('paid', T, first, last)).toBe('scheduled');
    expect(campaignStage('ads-missing', T, first, last)).toBe('missed');
    expect(campaignStage('ads-missing', last + 1, first, last)).toBe('missed');
    expect(campaignStage('paid', first, first, last)).toBe('missed');
    expect(campaignStage('ads-approved', first, first, last)).toBe('running');
    expect(campaignStage('running', first + 10, first, last)).toBe('running');
    expect(campaignStage('running', last, first, last)).toBe('done');
    expect(campaignStage('ads-approved', last + 1, first, last)).toBe('done');
    expect(campaignStage('report-sent', T, first, last)).toBe('done');
    expect(campaignStage('cancelled', T, first, last)).toBe('cancelled');
  });

  it('a note on what comes next', () => {
    expect(campaignNote('paid', 'scheduled', false, false)).toBe('Add your ads');
    expect(campaignNote('paid', 'scheduled', true, false)).toBe('Your ads are being checked');
    expect(campaignNote('ads-missing', 'missed', false, false)).toContain('did not run');
    expect(campaignNote('ads-approved', 'scheduled', true, false)).toBeNull();
    expect(campaignNote('report-sent', 'done', true, true)).toBe('Your report is ready');
    expect(campaignNote('draft', 'to-pay', false, false)).toContain('Not paid');
    expect(campaignNote('awaiting-payment', 'to-pay', false, false)).toContain(
      'Waiting for your payment',
    );
  });
});
