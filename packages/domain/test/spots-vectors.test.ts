import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { spotAt, type Carry, type HourPlan, type SpotChoice } from '../src/scheduler.js';

interface Vectors {
  plan: Pick<HourPlan, 'areaId' | 'startsAt' | 'recallAds'> & {
    lines: { lineId: string; kind: 'paid' | 'make-up' | 'trial'; ads: string[] }[];
    spotDemands: { id: string; kind: 'make-up' | 'aggregator'; ads: string[] }[];
  };
  cases: { carry: { lineId: string | null; spotId: string | null }; spots: string[] }[];
  noRecallAds: string[];
}
const V = JSON.parse(
  readFileSync(new URL('../test-vectors/spots.json', import.meta.url), 'utf8'),
) as Vectors;

const plan: HourPlan = {
  areaId: V.plan.areaId,
  date: '2026-11-02',
  startHour: 18,
  startsAt: V.plan.startsAt,
  revision: 1,
  lines: V.plan.lines.map((l) => ({ ...l, brandId: 'B', plays: 1, bikes: 1 })),
  spotDemands: V.plan.spotDemands.map((d) => ({ ...d, plays: 1 })),
  recallAds: V.plan.recallAds,
};
const show = (c: SpotChoice) =>
  `${c.kind}|${'lineId' in c ? c.lineId : 'id' in c ? c.id : ''}|${c.ad}`;
const carry = (c: Vectors['cases'][number]['carry']): Carry => ({
  lineId: c.lineId ?? undefined,
  spotId: c.spotId ?? undefined,
});

describe('spots (P2.5): the shared cases the Kotlin player also passes', () => {
  it('every spot of the hour, for every kind of carry', () => {
    expect(V.cases.length).toBe(6);
    for (const c of V.cases) {
      const got = Array.from({ length: 240 }, (_, i) => show(spotAt(plan, carry(c.carry), i)));
      expect(got).toEqual(c.spots);
    }
  });

  it('200 brand plays and 40 RECALL spots an hour, a brand ads taking turns', () => {
    const spots = V.cases[0]?.spots ?? [];
    expect(spots.filter((s) => s.startsWith('brand|')).length).toBe(200);
    expect(spots.filter((s, i) => i % 6 === 5).length).toBe(40);
    const ads = spots.filter((s) => s.startsWith('brand|')).map((s) => s.split('|')[2]);
    for (const ad of ['a1', 'a2', 'a3'])
      expect(ads.filter((a) => a === ad).length).toBeGreaterThanOrEqual(66);
  });

  it('spots count from 0: a negative or broken spot number is refused (as on the box)', () => {
    const c = { lineId: 'L-paid', spotId: undefined };
    expect(() => spotAt(plan, c, -1)).toThrow(/count from 0/);
    expect(() => spotAt(plan, c, 1.5)).toThrow(/count from 0/);
  });

  it('no RECALL ads in the plan: an empty ad (the screen shows its own slate)', () => {
    const empty = { ...plan, recallAds: [] };
    const got = Array.from({ length: 12 }, (_, i) =>
      show(spotAt(empty, { lineId: undefined, spotId: undefined }, i)),
    );
    expect(got).toEqual(V.noRecallAds);
  });
});
