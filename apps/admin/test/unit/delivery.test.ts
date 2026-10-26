import { describe, expect, it } from 'vitest';
import { statusChip, statusText, type DeliveryLine } from '../../lib/delivery';

const line = (
  view: Partial<DeliveryLine['view']>,
  x: Partial<DeliveryLine> = {},
): DeliveryLine => ({
  lineId: 'BK-1/hyd-madhapur/2027-08-24/17',
  bookingId: 'BK-1',
  brandName: 'Chai Co',
  areaId: 'hyd-madhapur',
  areaName: 'Madhapur',
  date: '2027-08-24',
  startHour: 17,
  bikes: 5,
  promised: 1000,
  counted: 900,
  bikesSeen: 4,
  makeUps: [],
  refund: null,
  view: { status: 'live', delivered: 900, missing: 100, makeUp: null, ...view },
  ...x,
});

describe('delivery in words (P3.10)', () => {
  it('each status reads plainly', () => {
    expect(statusText(line({}))).toBe('Live: 900 of 1,000 plays');
    expect(statusText(line({ status: 'delivered', delivered: 1040, missing: 0 }))).toBe(
      'Delivered: 1,040 of 1,000 plays (40 extra, free)',
    );
    // 18:00–20:00 India time on 24 Aug 2027.
    const from = Date.UTC(2027, 7, 24, 12, 30) / 1000;
    const m = {
      makeUpId: 'x#1',
      stage: 1 as const,
      from,
      until: from + 7200,
      owed: 100,
      counted: 40,
    };
    expect(statusText(line({ status: 'make-up', delivered: 940, missing: 60, makeUp: m }))).toBe(
      'Short 60: make-up in the next hours 18:00–20:00, 40 of 100 made up',
    );
    const refund = {
      refundId: 'r',
      missing: 60,
      basePaise: 150_000,
      gstPaise: 27_000,
      decision: null,
      decidedBy: null,
      reason: null,
    };
    expect(statusText(line({ status: 'refund-due', missing: 60 }, { refund }))).toBe(
      'Short 60: refund ₹1,500 + GST ₹270 proposed (a super admin decides)',
    );
    expect(statusChip('delivered')).toBe('rc-chip--go');
    expect(statusChip('refund-due')).toBe('rc-chip--stop');
    expect(statusChip('make-up')).toBe('rc-chip--paused');
  });
});
