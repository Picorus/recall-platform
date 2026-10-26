// P3.10: where a booking line stands, from its plays, make-ups and refund.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineView, type LineFacts } from '../src/delivery.js';

const START = 1_800_000_000;
const line = (x: Partial<LineFacts> = {}): LineFacts => ({
  state: 'ads-approved',
  startsAt: START,
  promised: 400,
  counted: 0,
  decided: [],
  makeUps: [],
  refund: null,
  ...x,
});

describe('delivery (P3.10)', () => {
  it('before, during and just after its hour', () => {
    expect(lineView(line(), START - 1).status).toBe('upcoming');
    expect(lineView(line({ counted: 150 }), START + 1800)).toMatchObject({
      status: 'live',
      delivered: 150,
      missing: 250,
    });
    expect(lineView(line({ counted: 390 }), START + 3700).status).toBe('counting');
  });

  it('delivered, made up, short, refunded', () => {
    const first = [{ step: 'first' as const, outcome: 'not needed' }];
    expect(lineView(line({ counted: 430, decided: first }), START + 4000)).toMatchObject({
      status: 'delivered',
      delivered: 430,
      missing: 0,
    });
    const m1 = {
      stage: 1 as const,
      from: START + 3600,
      until: START + 3 * 3600,
      owed: 100,
      counted: 40,
    };
    const short = line({
      counted: 300,
      decided: [{ step: 'first', outcome: 'make-up' }],
      makeUps: [m1],
    });
    expect(lineView(short, START + 4000)).toMatchObject({
      status: 'make-up',
      delivered: 340,
      missing: 60,
      makeUp: m1,
    });
    // The make-up made up the rest: delivered.
    expect(lineView({ ...short, makeUps: [{ ...m1, counted: 120 }] }, START + 4000).status).toBe(
      'delivered',
    );
    // After the first make-up, before the next day's opens: short.
    expect(lineView(short, START + 4 * 3600).status).toBe('short');
    const refund = { missing: 60, basePaise: 1500, gstPaise: 270, decision: null };
    expect(lineView({ ...short, refund }, START + 3 * 86_400).status).toBe('refund-due');
    expect(
      lineView({ ...short, refund: { ...refund, decision: 'approved' } }, START + 3 * 86_400)
        .status,
    ).toBe('refunded');
    expect(
      lineView({ ...short, refund: { ...refund, decision: 'rejected' } }, START + 3 * 86_400)
        .status,
    ).toBe('refund-rejected');
  });

  it('what comes next for a short line; the end of the road; late decisions; cancelled with a refund', () => {
    const base = line({ counted: 300 });
    expect(lineView(base, START + 3600 + 600 + 301)).toMatchObject({
      status: 'counting',
      overdue: true,
    });
    expect(lineView(base, START + 3700).overdue).toBe(false);
    const first = { step: 'first' as const, outcome: 'make-up' };
    const second = { step: 'second' as const, outcome: 'make-up' };
    expect(lineView({ ...base, decided: [first] }, START + 5 * 3600).next).toBe('make-up');
    expect(lineView({ ...base, decided: [first, second] }, START + 2 * 86_400).next).toBe('refund');
    const done = [first, second, { step: 'refund' as const, outcome: 'nothing paid' }];
    expect(lineView({ ...base, decided: done }, START + 3 * 86_400).status).toBe('short-final');
    const refund = { missing: 400, basePaise: 9000, gstPaise: 1620, decision: null };
    expect(lineView(line({ state: 'cancelled', refund }), START - 86_400).status).toBe(
      'refund-due',
    );
    // A paid booking's later lines wait for ads only until its first hour.
    expect(
      lineView(line({ state: 'paid', bookingStartsAt: START - 86_400 }), START - 10).status,
    ).toBe('ads-missing');
  });

  it('bookings that never ran', () => {
    expect(lineView(line({ state: 'draft' }), START + 10).status).toBe('not-sold');
    expect(lineView(line({ state: 'cancelled' }), START - 10).status).toBe('cancelled');
    expect(lineView(line({ state: 'paid' }), START - 10).status).toBe('waiting-ads');
    expect(lineView(line({ state: 'paid' }), START + 10).status).toBe('ads-missing');
    expect(lineView(line({ state: 'ads-missing' }), START + 10).status).toBe('ads-missing');
  });

  it('missing is never below 0 or above what was promised; extra plays are a bonus', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 3000 }),
        (promised, counted, made) => {
          const v = lineView(
            line({
              promised,
              counted,
              makeUps: [{ stage: 1, from: START, until: START + 1, owed: 1, counted: made }],
            }),
            START + 10 * 86_400,
          );
          expect(v.delivered).toBe(counted + made);
          expect(v.missing).toBe(Math.max(0, promised - counted - made));
          expect(v.missing).toBeLessThanOrEqual(promised);
        },
      ),
    );
  });
});
