import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fallbackPick, fnv1a32, hash32, type HourPlan } from '../src/scheduler.js';
import { downTopic, topicAllowed } from '../src/screen-link.js';
import {
  areasText,
  assignText,
  parseAreas,
  parseAssign,
  parsePlans,
  plansText,
  type ScreenArea,
  type ScreenPlan,
} from '../src/screen-plan.js';

interface Vectors {
  made: number;
  areas: { text: string; parsed: ScreenArea[] };
  plans: { text: string; parsed: ScreenPlan[] };
  assign: {
    text: string;
    areaId: string;
    startsAt: number;
    lineId: string | null;
    spotId: string | null;
  }[];
  refused: { kind: string; text: string; problem: string }[];
  hashes: { s: string; fnv1a32: number; hash32: number }[];
  screens: string[];
  picks: { areaId: string; startsAt: number; carries: [string | null, string | null][] }[];
}
const V = JSON.parse(
  readFileSync(new URL('../test-vectors/screen-plan.json', import.meta.url), 'utf8'),
) as Vectors;
const ME = 'SCR-0123456Z';
const asPlan = (p: ScreenPlan): HourPlan => ({
  ...p,
  lines: p.lines.map((l) => ({ ...l, brandId: 'B' })),
});

describe('screen plans (P2.6): the shared cases the Kotlin player also passes', () => {
  it('areas, plans and assignments read back exactly; every refusal has its reason', () => {
    expect(parseAreas(V.areas.text)).toEqual({ made: V.made, areas: V.areas.parsed });
    expect(areasText(V.areas.parsed, V.made)).toBe(V.areas.text);
    expect(parsePlans(V.plans.text)).toEqual({ made: V.made, plans: V.plans.parsed });
    expect(plansText(V.plans.parsed.map(asPlan), V.made)).toBe(V.plans.text);
    for (const a of V.assign) {
      const carry = { lineId: a.lineId ?? undefined, spotId: a.spotId ?? undefined };
      expect(parseAssign(a.text)).toEqual({
        made: V.made,
        areaId: a.areaId,
        startsAt: a.startsAt,
        carry,
      });
      expect(assignText({ areaId: a.areaId, startsAt: a.startsAt, carry }, V.made)).toBe(a.text);
    }
    const parse = { areas: parseAreas, plan: parsePlans, assign: parseAssign };
    for (const r of V.refused) {
      expect(parse[r.kind as keyof typeof parse](r.text), r.text).toEqual({ problem: r.problem });
    }
  });

  it('the screen own pick without an assignment, for 200 screens and 4 plans', () => {
    for (const h of V.hashes) {
      expect(fnv1a32(h.s)).toBe(h.fnv1a32);
      expect(hash32(h.s)).toBe(h.hash32);
    }
    for (const p of V.picks) {
      const plan = V.plans.parsed.find((x) => x.areaId === p.areaId && x.startsAt === p.startsAt);
      expect(plan).toBeDefined();
      if (!plan) continue;
      const got = V.screens.map((s) => {
        const c = fallbackPick(asPlan(plan), s);
        return [c.lineId ?? null, c.spotId ?? null];
      });
      expect(got).toEqual(p.carries);
    }
  });

  it('the cloud can never send a message the screen refuses', () => {
    const [a] = V.areas.parsed;
    expect(a).toBeDefined();
    if (!a) return;
    expect(() => areasText([a, a], V.made)).toThrow(/twice/);
    expect(() => areasText([{ ...a, ring: a.ring.slice(0, 2) }], V.made)).toThrow(/shape/);
    expect(() =>
      assignText(
        { areaId: 'Bad Id', startsAt: 1793622600, carry: { lineId: undefined, spotId: undefined } },
        V.made,
      ),
    ).toThrow(/area id/);
  });

  it('each travels on the screen own down topics, which only that screen may hear', () => {
    for (const kind of ['areas', 'plan', 'assign'] as const) {
      expect(topicAllowed(ME, downTopic(ME, kind), 'subscribe')).toBe(true);
      expect(topicAllowed(ME, downTopic(ME, kind), 'publish')).toBe(false);
    }
  });
});
