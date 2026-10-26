import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assign,
  brandPlaysPerHour,
  addMakeUps,
  buildHourPlan,
  DEFAULT_SPOT_RULES as RULES,
  fallbackPick,
  fnv1a32,
  hash32,
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
const SPOTS = new Map<string, number>();
/** hash32 of '', 'a' and a real key: copy these into the Kotlin player's tests. */
const HASH_VECTORS = [2872998923, 444641715, 1673192015];
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

describe('make-ups that open after a plan was sent (P1.6.2)', () => {
  it('the plan is re-sent with the make-up first in RECALL spots and after paid lines for spare bikes', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 5)],
      trials: [paid('T1', 5)],
      aggregator: [{ id: 'AGG', ads: ['agg'], plays: 100 }],
    });
    const more = addMakeUps(plan, [{ lineId: 'OLD#1', brandId: 'b', ads: ['old'], plays: 300 }]);
    expect(more.revision).toBe(2);
    expect(more.lines.map((l) => l.lineId)).toEqual(['L1', 'OLD#1', 'T1']);
    expect(more.spotDemands.map((d) => d.id)).toEqual(['OLD#1', 'AGG']);
    // The same make-up again with fewer plays owed replaces the old numbers.
    const again = addMakeUps(more, [{ lineId: 'OLD#1', brandId: 'b', ads: ['old'], plays: 120 }]);
    expect(again.lines.filter((l) => l.lineId === 'OLD#1').map((l) => l.plays)).toEqual([120]);
    expect(again.revision).toBe(3);
  });

  it('a spare bike carrying a make-up plays it as a make-up, so it counts for the make-up', () => {
    const plan = addMakeUps(buildHourPlan(base), [
      { lineId: 'OLD#1', brandId: 'b', ads: ['old'], plays: 300 },
    ]);
    expect(spotAt(plan, { lineId: 'OLD#1', spotId: undefined }, 0)).toEqual({
      kind: 'make-up',
      id: 'OLD#1',
      ad: 'old',
    });
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
    const m = assign(plan, bikesIn(40), NONE, SPOTS, START, RULES, FULL);
    expect([count(m, 'L1'), count(m, 'L2'), count(m, 'T1')]).toEqual([20, 10, 10]);
  });

  it('bikes leave areas: by default each is counted on for 90% of its plays, so paid lines get a few extra', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 20), paid('L2', 10)],
      trials: [paid('T1', 20)],
    });
    const m = assign(plan, bikesIn(40), NONE, SPOTS, START);
    // 4,000 plays ÷ 180 a bike = 23 bikes; 2,000 ÷ 180 = 12; the trial gets the 5 left.
    expect([count(m, 'L1'), count(m, 'L2'), count(m, 'T1')]).toEqual([23, 12, 5]);
  });

  it('too few bikes: paid lines share them by gap; trials and RECALL get none', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 30), paid('L2', 10)],
      trials: [paid('T1', 50)],
    });
    const m = assign(plan, bikesIn(20), NONE, SPOTS, START);
    expect(count(m, 'T1') + count(m, undefined)).toBe(0);
    expect(count(m, 'L1')).toBeGreaterThan(count(m, 'L2'));
  });

  it('a bike keeps its line while the line has a gap (no flicker); extra bikes and a finished line free bikes', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5), paid('L2', 5)] });
    const bikes = bikesIn(10).map((b, i) => ({
      ...b,
      carrying: { lineId: i < 8 ? 'L1' : 'L2', spotId: undefined },
      carried: [i < 8 ? 'L1' : 'L2'],
    }));
    const kept = assign(plan, bikes, NONE, SPOTS, START + 600);
    // L1 needs 1,000 plays; each bike is counted on for 150 from here: 7 keep it, the 8th goes to L2.
    expect(count(kept, 'L1')).toBe(7);
    expect(count(kept, 'L2')).toBe(3);
    for (const b of bikes.slice(0, 7)) expect(kept.get(b.screenId)?.lineId).toBe('L1');
    const done = new Map([['L1', { plays: 1000, bikes: 8 }]]);
    const after = assign(plan, bikes, done, SPOTS, START + 600);
    expect(count(after, 'L1')).toBe(0);
    // L1 is done: every bike goes to L2 (the spare ones top it up rather than play RECALL's ads).
    expect(count(after, 'L2')).toBe(10);
  });

  it('a line still short of different bikes is given bikes that have not carried it', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5)], trials: [paid('T1', 5)] });
    // L1 has had 2 different bikes and needs 3 more; 3 old bikes (carried L1) and 3 new ones are free.
    const old = bikesIn(3, 'old').map((b) => ({ ...b, carried: ['L1'] }));
    const m = assign(
      plan,
      [...old, ...bikesIn(3, 'new')],
      new Map([['L1', { plays: 400, bikes: 2 }]]),
      SPOTS,
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
    const m = assign(plan, bikesIn(10), NONE, SPOTS, START, RULES, FULL);
    expect([...m.values()].every((c) => c.spotId === 'OLD')).toBe(true);
    // L1 first (5 bikes), then 1 bike for what the spots cannot cover; the spare 4 top up L1.
    expect(count(m, 'OLD')).toBe(1);
    expect(count(m, 'L1')).toBe(9);
    // Nothing owed: the aggregator gets the spots.
    const none = buildHourPlan({ ...base, aggregator: [{ id: 'AGG', ads: ['agg'], plays: 80 }] });
    const n = assign(none, bikesIn(4), NONE, SPOTS, START, RULES, FULL);
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
    const m = assign(plan, bikes, NONE, SPOTS, START, RULES, FULL);
    expect([...m.values()].map((c) => c.spotId).sort()).toEqual(['AGG', 'OLD']);
  });

  it('a make-up or trial never keeps a bike a paid line needs', () => {
    const plan = buildHourPlan({
      ...base,
      paid: [paid('L1', 5)],
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 600 }],
      trials: [paid('T1', 5)],
    });
    const bikes = bikesIn(6).map((b, i) => ({
      ...b,
      carrying: { lineId: i < 3 ? 'OLD' : 'T1', spotId: undefined },
      carried: [i < 3 ? 'OLD' : 'T1'],
    }));
    const m = assign(plan, bikes, NONE, SPOTS, START + 60);
    expect(count(m, 'L1')).toBe(6);
  });

  it('a make-up already delivered in RECALL spots frees its bikes', () => {
    const plan = buildHourPlan({
      ...base,
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 600 }],
    });
    const bikes = bikesIn(6).map((b) => ({
      ...b,
      carrying: { lineId: 'OLD', spotId: 'OLD' },
      carried: ['OLD'],
    }));
    const m = assign(plan, bikes, NONE, new Map([['OLD', 600]]), START + 60);
    expect(count(m, 'OLD')).toBe(0);
    expect([...m.values()].every((c) => c.spotId === undefined)).toBe(true);
  });

  it('over-covered lines give bikes back: 11 bikes all on L1 at first, both lines delivered', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5), paid('L2', 5)] });
    let carry = new Map<string, Carry>(
      bikesIn(11).map((b) => [b.screenId, { lineId: 'L1', spotId: undefined }]),
    );
    const plays = new Map<string, number>();
    const seen = new Map<string, Set<string>>();
    for (let s = 0; s < 3600; s += 15) {
      if (s % 60 === 0) {
        const progress = new Map(
          [...plays].map(([id, n]) => [id, { plays: n, bikes: seen.get(id)?.size ?? 0 }]),
        );
        const bikes = bikesIn(11).map((b) => ({
          ...b,
          carrying: carry.get(b.screenId),
          carried: [...seen].filter(([, set]) => set.has(b.screenId)).map(([id]) => id),
        }));
        carry = assign(plan, bikes, progress, SPOTS, START + s);
      }
      if (isRecallSpot(s / 15, RULES)) continue;
      for (const [screen, c] of carry) {
        if (c.lineId === undefined) continue;
        plays.set(c.lineId, (plays.get(c.lineId) ?? 0) + 1);
        seen.set(c.lineId, (seen.get(c.lineId) ?? new Set()).add(screen));
      }
    }
    expect(plays.get('L1')).toBeGreaterThanOrEqual(1000);
    expect(plays.get('L2')).toBeGreaterThanOrEqual(1000);
    expect(seen.get('L2')?.size).toBeGreaterThanOrEqual(5);
  });

  it('a line short of different bikes gets new bikes even when its plays are covered', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5)] });
    const old = bikesIn(2, 'old').map((b) => ({
      ...b,
      carrying: { lineId: 'L1', spotId: undefined },
      carried: ['L1'],
    }));
    const m = assign(
      plan,
      [...old, ...bikesIn(3, 'new')],
      new Map([['L1', { plays: 700, bikes: 2 }]]),
      SPOTS,
      START + 1800,
    );
    for (const b of bikesIn(3, 'new')) expect(m.get(b.screenId)?.lineId).toBe('L1');
  });

  it('at the last brand spot, free bikes still spread over the lines that need a play', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5), paid('L2', 5)] });
    const m = assign(
      plan,
      bikesIn(11),
      new Map([
        ['L1', { plays: 990, bikes: 5 }],
        ['L2', { plays: 999, bikes: 5 }],
      ]),
      SPOTS,
      START + 3570,
    );
    expect([count(m, 'L1'), count(m, 'L2')]).toEqual([10, 1]);
  });

  it('a screen listed twice is refused', () => {
    const plan = buildHourPlan({ ...base, paid: [paid('L1', 5)] });
    expect(() => assign(plan, [...bikesIn(1), ...bikesIn(1)], NONE, SPOTS, START)).toThrow(
      /listed twice/,
    );
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
          const m = assign(plan, bikes, NONE, SPOTS, START + at);
          const r = assign(plan, [...bikes].reverse(), NONE, SPOTS, START + at);
          expect(m.size).toBe(n);
          expect([...m.entries()].sort()).toEqual([...r.entries()].sort());
          for (const c of m.values()) {
            if (c.lineId !== undefined) expect(ids).toContain(c.lineId);
            if (c.spotId !== undefined) expect(c.spotId).toBe('OLD');
          }
          // While a paid line still has a gap, no bike plays RECALL's own ads or a make-up.
          const full = playsLeft(plan, START + at).brand;
          const each = full === 0 ? 0 : Math.max(1, Math.floor(full * 0.9));
          const shortPaid = plan.lines.some(
            (l) => l.kind === 'paid' && l.plays > count(m, l.lineId) * each,
          );
          if (shortPaid && full > 0)
            expect(
              [...m.values()].filter((c) => c.lineId === undefined || c.lineId === 'OLD'),
            ).toEqual([]);
        },
      ),
      { numRuns: 300 },
    );
    // Hundreds of random fleets: a slow CI machine needs more than the default 5 seconds.
  }, 30_000);
});

describe('offline fallback (P1.4.3)', () => {
  it('FNV-1a matches the published test values (the Kotlin player must give the same)', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('the mixed hash is pinned (the Kotlin player must give the same)', () => {
    expect([hash32(''), hash32('a'), hash32('sim-1|L1|hyd-madhapur|2028-04-11|18')]).toEqual(
      HASH_VECTORS,
    );
  });

  it('20,000 screens with no network split across lines in proportion to bikes sold (within 1%)', () => {
    for (const sizes of [
      [30, 10],
      [20, 20, 7],
    ]) {
      const plan = buildHourPlan({ ...base, paid: sizes.map((n, i) => paid(`L${i}`, n)) });
      const picks = new Map<string, number>();
      for (const b of bikesIn(20_000, 'sim')) {
        const id = fallbackPick(plan, b.screenId).lineId ?? '-';
        picks.set(id, (picks.get(id) ?? 0) + 1);
      }
      const total = sizes.reduce((a, b) => a + b, 0);
      sizes.forEach((n, i) =>
        expect(Math.abs((picks.get(`L${i}`) ?? 0) / 20_000 - n / total)).toBeLessThan(0.01),
      );
    }
  });

  it('offline RECALL spots: make-ups owed first, aggregator ads only when none is owed', () => {
    const plan = buildHourPlan({
      ...base,
      makeUps: [{ lineId: 'OLD', brandId: 'b', ads: ['old'], plays: 40 }],
      aggregator: [{ id: 'AGG', ads: ['agg'], plays: 2000 }],
    });
    for (const b of bikesIn(100)) expect(fallbackPick(plan, b.screenId).spotId).toBe('OLD');
    const none = buildHourPlan({
      ...base,
      aggregator: plan.spotDemands.filter((d) => d.kind === 'aggregator'),
    });
    expect(fallbackPick(none, 'scr-1').spotId).toBe('AGG');
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
