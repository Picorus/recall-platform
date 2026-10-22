import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assign,
  brandPlaysPerHour,
  buildHourPlan,
  DEFAULT_SPOT_RULES as RULES,
  fallbackPick,
  fnv1a32,
  isRecallSpot,
  playsLeft,
  recallSpotsPerHour,
  spotAt,
  spotsPerHour,
  type AssignRules,
  type BikeNow,
  type Carry,
  type PlanInput,
  type Progress,
} from '../src/scheduler.js';

// Madhapur, Tue 11 Apr 2028, 6–7 pm India time.
const START = Date.UTC(2028, 3, 11, 12, 30) / 1000;
const base: PlanInput = {
  areaId: 'hyd-madhapur',
  date: '2028-04-11',
  startHour: 18,
  startsAt: START,
  paid: [],
  makeUps: [],
  trials: [],
  aggregator: [],
  recallAds: ['recall-1', 'recall-2'],
};
const paid = (lineId: string, bikes: number) => ({
  lineId,
  brandId: `brand-${lineId}`,
  ads: [`${lineId}-a`, `${lineId}-b`],
  bikes,
});
const bikesIn = (n: number, prefix = 'scr'): BikeNow[] =>
  Array.from({ length: n }, (_, i) => ({
    screenId: `${prefix}-${String(i).padStart(5, '0')}`,
    carried: [],
  }));
const count = (m: Map<string, Carry>, lineId: string | undefined) =>
  [...m.values()].filter((c) => c.lineId === lineId).length;
const NONE = new Map<string, Progress>();
/** Count on every bike for all its remaining plays (to see the plain split). */
const FULL: AssignRules = { expectStayBp: 10_000 };

describe('the 240 spots (P1.4.5)', () => {
  it('an hour is 240 spots of 15 s: 200 brand plays and 40 RECALL spots, one after every 5', () => {
    expect([spotsPerHour(RULES), brandPlaysPerHour(RULES), recallSpotsPerHour(RULES)]).toEqual([
      240, 200, 40,
    ]);
    const pattern = Array.from({ length: 12 }, (_, i) => (isRecallSpot(i, RULES) ? 'R' : 'b'));
    expect(pattern.join('')).toBe('bbbbbRbbbbbR');
  });

  it('a bike gives 200 brand plays and 40 RECALL spots in a full hour; half that from half past', () => {
    const plan = buildHourPlan(base);
    expect(playsLeft(plan, START)).toEqual({ brand: 200, recall: 40 });
    expect(playsLeft(plan, START + 1800)).toEqual({ brand: 100, recall: 20 });
    expect(playsLeft(plan, START + 3600)).toEqual({ brand: 0, recall: 0 });
    expect(playsLeft(plan, START - 600)).toEqual({ brand: 200, recall: 40 });
  });
});

describe('the hour plan (P1.4.1)', () => {
  it('a paid line of 20 bikes needs 4,000 plays on 20 different bikes', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 20)] });
    expect(plan.lines).toEqual([
      expect.objectContaining({ lineId: 'L1', kind: 'paid', plays: 4000, bikes: 20 }),
    ]);
  });

  it('refuses a line with 1 ad or 6 ads, the same id twice, and no RECALL ads', () => {
    const bad = {
      ...base,
      paid: [{ ...paid('L1', 5), ads: ['x'] }, paid('L2', 5)],
      trials: [{ ...paid('L2', 5), ads: ['1', '2', '3', '4', '5', '6'] }],
      recallAds: [],
    };
    expect(() => buildHourPlan(bad)).toThrow(/L1: needs 2 to 5 ads/);
    expect(() => buildHourPlan(bad)).toThrow(/L2: listed twice/);
    expect(() => buildHourPlan(bad)).toThrow(/L2: needs 2 to 5 ads/);
    expect(() => buildHourPlan(bad)).toThrow(/RECALL needs at least 1 ad/);
  });

  it('RECALL spots are filled make-ups first, then aggregator ads; whole bikes paid → make-ups → trials', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 5)],
      trials: [paid('T1', 5)],
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old-a'], plays: 120 }],
      aggregator: [{ id: 'AGG', ads: ['agg-a'], plays: 500 }],
    });
    expect(plan.lines.map((l) => `${l.kind}:${l.lineId}`)).toEqual([
      'paid:L1',
      'make-up:OLD',
      'trial:T1',
    ]);
    expect(plan.spotDemands.map((d) => `${d.kind}:${d.id}`)).toEqual([
      'make-up:OLD',
      'aggregator:AGG',
    ]);
  });
});

describe('what a screen plays (P1.4.4)', () => {
  const plan = buildHourPlan({
    ...base,
    paid: [{ ...paid('L1', 5), ads: ['a', 'b', 'c'] }],
    aggregator: [{ id: 'AGG', ads: ['agg'], plays: 100 }],
  });

  it("only the carried brand's ads, in turn, with a RECALL spot after every 5", () => {
    const carry = { lineId: 'L1', spotId: 'AGG' };
    const ads = Array.from({ length: 12 }, (_, i) => spotAt(plan, carry, i).ad);
    expect(ads).toEqual(['a', 'b', 'c', 'a', 'b', 'agg', 'c', 'a', 'b', 'c', 'a', 'agg']);
  });

  it("nothing carried, or an id not in the plan: RECALL's own ads", () => {
    expect(spotAt(plan, { lineId: undefined, spotId: undefined }, 0)).toEqual({
      kind: 'recall',
      ad: 'recall-1',
    });
    expect(spotAt(plan, { lineId: 'GONE', spotId: 'GONE' }, 5).kind).toBe('recall');
  });
});

describe('live assignment (P1.4.2)', () => {
  it('40 bikes, lines of 20 and 10: each gets its bikes, a trial gets the spare 10 after them', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 20), paid('L2', 10)],
      trials: [paid('T1', 20)],
    });
    const m = assign(plan, bikesIn(40), NONE, START, RULES, FULL);
    expect([count(m, 'L1'), count(m, 'L2'), count(m, 'T1')]).toEqual([20, 10, 10]);
  });

  it('bikes leave areas: by default each is counted on for 90% of its plays, so paid lines get a few extra', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 20), paid('L2', 10)],
      trials: [paid('T1', 20)],
    });
    const m = assign(plan, bikesIn(40), NONE, START);
    // 4,000 plays ÷ 180 a bike = 23 bikes; 2,000 ÷ 180 = 12; the trial gets the 5 left.
    expect([count(m, 'L1'), count(m, 'L2'), count(m, 'T1')]).toEqual([23, 12, 5]);
  });

  it('too few bikes: paid lines share them by gap; trials and RECALL get none', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 30), paid('L2', 10)],
      trials: [paid('T1', 50)],
    });
    const m = assign(plan, bikesIn(20), NONE, START);
    expect(count(m, 'T1') + count(m, undefined)).toBe(0);
    expect(count(m, 'L1')).toBeGreaterThan(count(m, 'L2'));
  });

  it('a bike keeps its line while the line still needs plays (no flicker), and is freed when it is done', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5), paid('L2', 5)] });
    const bikes = bikesIn(10).map((b, i) => ({
      ...b,
      carrying: { lineId: i < 8 ? 'L1' : 'L2', spotId: undefined },
      carried: [i < 8 ? 'L1' : 'L2'],
    }));
    const kept = assign(plan, bikes, NONE, START + 600);
    expect(count(kept, 'L1')).toBe(8);
    const done = new Map([['L1', { plays: 1000, bikes: 8 }]]);
    const after = assign(plan, bikes, done, START + 600);
    expect(count(after, 'L1')).toBe(0);
    // L2 gets enough bikes for its 1,000 plays (about 167 each from here); the rest play RECALL's.
    const each = playsLeft(plan, START + 600).brand;
    expect(count(after, 'L2') * each).toBeGreaterThanOrEqual(1000);
    expect((count(after, 'L2') - 1) * each).toBeLessThan(1000);
    expect(count(after, undefined)).toBe(10 - count(after, 'L2'));
  });

  it('a line still short of different bikes is given bikes that have not carried it', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5)], trials: [paid('T1', 5)] });
    // L1 has had 2 different bikes and needs 3 more; 3 old bikes (carried L1) and 3 new ones are free.
    const old = bikesIn(3, 'old').map((b) => ({ ...b, carried: ['L1'] }));
    const m = assign(
      plan,
      [...old, ...bikesIn(3, 'new')],
      new Map([['L1', { plays: 400, bikes: 2 }]]),
      START + 1200,
    );
    for (const b of bikesIn(3, 'new')) expect(m.get(b.screenId)?.lineId).toBe('L1');
  });

  it('a make-up uses RECALL spots first; what spots cannot cover takes a spare bike after paid lines', () => {
    // 10 bikes give 400 RECALL spots; 600 plays are owed; one paid line of 5 bikes.
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 5)],
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 600 }],
      aggregator: [{ id: 'AGG', ads: ['agg'], plays: 500 }],
    });
    const m = assign(plan, bikesIn(10), NONE, START, RULES, FULL);
    expect([...m.values()].every((c) => c.spotId === 'OLD')).toBe(true);
    expect(count(m, 'L1')).toBe(5);
    expect(count(m, 'OLD')).toBe(1);
    // Nothing owed: the aggregator gets the spots.
    const none = buildHourPlan({ ...base, aggregator: [{ id: 'AGG', ads: ['agg'], plays: 80 }] });
    const n = assign(none, bikesIn(4), NONE, START, RULES, FULL);
    expect([...n.values()].map((c) => c.spotId)).toEqual(['AGG', 'AGG', undefined, undefined]);
  });

  it('a bike on an aggregator ad moves to a make-up when one is owed', () => {
    const plan = buildHourPlan({
      ...base,
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 40 }],
      aggregator: [{ id: 'AGG', ads: ['agg'], plays: 500 }],
    });
    const bikes = bikesIn(2).map((b) => ({
      ...b,
      carrying: { lineId: undefined, spotId: 'AGG' },
    }));
    const m = assign(plan, bikes, NONE, START, RULES, FULL);
    expect([...m.values()].map((c) => c.spotId).sort()).toEqual(['AGG', 'OLD']);
  });

  it('property: every bike gets exactly one answer, only from the plan, the same whatever the order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 5, max: 40 }), { minLength: 0, maxLength: 6 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 0, max: 3600 }),
        fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 120 }),
        (sizes, n, at, sticky) => {
          const plan = buildHourPlan({
            ...base,
            paid: sizes.map((b, i) => paid(`L${i}`, b)),
            makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 300 }],
          });
          const ids = plan.lines.map((l) => l.lineId);
          const bikes = bikesIn(n).map((b, i) => {
            const was = ids[(sticky[i] ?? 0) % Math.max(1, ids.length)];
            return {
              ...b,
              carrying: { lineId: was, spotId: undefined },
              carried: was ? [was] : [],
            };
          });
          const m = assign(plan, bikes, NONE, START + at);
          const r = assign(plan, [...bikes].reverse(), NONE, START + at);
          expect(m.size).toBe(n);
          expect([...m.entries()].sort()).toEqual([...r.entries()].sort());
          for (const c of m.values()) {
            if (c.lineId !== undefined) expect(ids).toContain(c.lineId);
            if (c.spotId !== undefined) expect(c.spotId).toBe('OLD');
          }
          // Paid lines are never left short while a bike plays RECALL's own ads or a make-up.
          const left = playsLeft(plan, START + at).brand;
          const shortPaid = plan.lines.some(
            (l) => l.kind === 'paid' && l.plays > count(m, l.lineId) * left,
          );
          if (shortPaid && left > 0) {
            const idle = [...m.entries()].filter(
              ([s, c]) =>
                c.lineId === undefined ||
                (c.lineId === 'OLD' &&
                  bikes.find((b) => b.screenId === s)?.carrying?.lineId !== 'OLD'),
            );
            expect(idle).toEqual([]);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('offline fallback (P1.4.3)', () => {
  it('FNV-1a matches the published test values (the Kotlin player must give the same)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('10,000 screens with no network split across lines in proportion to bikes sold', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 30), paid('L2', 10)] });
    const picks = new Map<string, number>();
    for (const b of bikesIn(10_000)) {
      const id = fallbackPick(plan, b.screenId).lineId ?? '-';
      picks.set(id, (picks.get(id) ?? 0) + 1);
    }
    expect((picks.get('L1') ?? 0) / 10_000).toBeCloseTo(0.75, 1);
    expect((picks.get('L2') ?? 0) / 10_000).toBeCloseTo(0.25, 1);
  });

  it('the same screen picks the same line all hour; trials only when nothing is paid', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5)], trials: [paid('T1', 5)] });
    expect(fallbackPick(plan, 'scr-1')).toEqual(fallbackPick(plan, 'scr-1'));
    expect(fallbackPick(plan, 'scr-1').lineId).toBe('L1');
    const trialOnly = buildHourPlan({ ...base, trials: [paid('T1', 5)] });
    expect(fallbackPick(trialOnly, 'scr-1').lineId).toBe('T1');
    expect(fallbackPick(buildHourPlan(base), 'scr-1')).toEqual({
      lineId: undefined,
      spotId: undefined,
    });
  });
});
