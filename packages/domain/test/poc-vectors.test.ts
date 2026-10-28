// P7.8: shared cases for the POC rotation and its message (test-vectors/poc.json). The Kotlin player
// (apps/player core PocTest) must read the same messages, refuse the same ones for the same reasons
// and play exactly the same 240 spots. Regenerate after a deliberate change with:
//   UPDATE_VECTORS=1 pnpm --filter @recall/domain test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POC_PAY_ZONE } from '../src/pay-zone.js';
import {
  parsePocPlans,
  pocMonthWindow,
  pocOffset,
  pocPlanCovers,
  pocPlansText,
  pocRef,
  pocSpotAt,
  type PocPlan,
} from '../src/poc.js';
import type { SpotChoice } from '../src/scheduler.js';

const FILE = new URL('../test-vectors/poc.json', import.meta.url);
const MADE = 1_793_620_000_000;
const MONTH = '2026-11';
const W = pocMonthWindow(MONTH);

const brands = (n: number, month = MONTH) =>
  Array.from({ length: n }, (_, i) => ({
    ref: pocRef(`brand-${String(i + 1).padStart(2, '0')}`, month),
    ads: Array.from({ length: 1 + (i % 5) }, (_, k) => `poc-${i + 1}-${k + 1}`),
  }));

const full: PocPlan = {
  month: MONTH,
  ...W,
  zone: POC_PAY_ZONE,
  slots: 40,
  perBrand: 5,
  brands: brands(40),
  recallAds: ['recall-a', 'recall-b', 'recall-c'],
};
const few: PocPlan = {
  ...full,
  month: '2026-12',
  ...pocMonthWindow('2026-12'),
  // Switched off on 10 December: the month ends early.
  endsAt: pocMonthWindow('2026-12').startsAt + 9 * 86_400,
  zone: { kind: 'areas', areaIds: ['hyd-hitech-city', 'hyd-madhapur'], withEdge: true },
  brands: brands(7, '2026-12'),
};
const odd: PocPlan = { ...full, slots: 30, perBrand: 6, brands: brands(30) };
/** Two brands of the month with no ads (one not paid yet, one with none approved): their slots stay
 * theirs, filled by RECALL, and nobody else moves. */
const gaps: PocPlan = {
  ...full,
  brands: full.brands.map((b, i) => (i === 3 || i === 17 ? { ...b, ads: [] } : b)),
};

const show = (c: SpotChoice) => `${c.kind}|${c.kind === 'brand' ? c.lineId : ''}|${c.ad}`;

function build() {
  const okText = pocPlansText([gaps, few], MADE);
  const parsed = JSON.parse(okText) as { plans: Record<string, unknown>[] };
  const refused: { text: string; problem: string }[] = [];
  const bad = (f: (x: { v: unknown; made: unknown; plans: Record<string, unknown>[] }) => void) => {
    const x = structuredClone(parsed) as {
      v: unknown;
      made: unknown;
      plans: Record<string, unknown>[];
    };
    (x as Record<string, unknown>).made = MADE;
    (x as Record<string, unknown>).v = 1;
    f(x);
    const text = JSON.stringify(x);
    const r = parsePocPlans(text);
    if (!('problem' in r)) throw new Error(`case taken: ${text.slice(0, 80)}`);
    refused.push({ text, problem: r.problem });
  };
  const p0 = (x: { plans: Record<string, unknown>[] }) => x.plans[0] ?? {};
  bad((x) => (x.v = 2));
  bad((x) => (x.made = 0));
  bad((x) => (x.plans = [...x.plans, ...x.plans]));
  bad((x) => (x.plans = [p0(x), { ...p0(x), month: '2027-01' }, x.plans[1] ?? {}, p0(x)]));
  bad((x) => (p0(x).month = '2026-13'));
  bad((x) => (p0(x).startsAt = W.startsAt + 3600));
  bad((x) => (p0(x).endsAt = W.endsAt + 1));
  bad((x) => (p0(x).endsAt = W.startsAt));
  bad((x) => (p0(x).zone = { kind: 'circle', centre: { lat: 17.45, lng: 200 }, radiusM: 15000 }));
  bad((x) => (p0(x).zone = { kind: 'circle', centre: { lat: 17.45, lng: 78.38 }, radiusM: 0 }));
  bad((x) => (p0(x).zone = { kind: 'areas', areaIds: [], withEdge: true }));
  bad((x) => (p0(x).zone = { kind: 'square' }));
  bad((x) => (p0(x).slots = 241));
  bad((x) => (p0(x).perBrand = 0));
  bad((x) => (p0(x).recallAds = ['bad ad']));
  bad((x) => (p0(x).brands = brands(41)));
  bad((x) => (p0(x).brands = [{ ref: 'poc/brand-01/2026-12', ads: ['a'] }]));
  bad((x) => (p0(x).brands = [{ ref: 'poc/Brand/2026-11', ads: ['a'] }]));
  bad((x) => (p0(x).brands = [brands(1)[0], brands(1)[0]]));
  bad(
    (x) => (p0(x).brands = [{ ref: 'poc/brand-01/2026-11', ads: ['a', 'b', 'c', 'd', 'e', 'f'] }]),
  );
  bad((x) => (p0(x).brands = [{ ref: 'poc/brand-01/2026-11', ads: ['a'], extra: 1 }]));
  bad((x) => (p0(x).extra = true));
  refused.push({ text: '{"v":1', problem: 'not a POC plans list' });

  const hour = W.startsAt + 10 * 3600; // 18:00 on 1 November
  const screens = ['SCR-0000001A', 'SCR-0123456Z', 'SCR-9ZZZZZZZ'];
  const rotations = [
    { name: '40 brands', plan: full, screenId: screens[0] ?? '', hourStartsAt: hour },
    {
      name: '40 brands, another screen',
      plan: full,
      screenId: screens[1] ?? '',
      hourStartsAt: hour,
    },
    {
      name: '40 brands, the next hour',
      plan: full,
      screenId: screens[0] ?? '',
      hourStartsAt: hour + 3600,
    },
    {
      name: '7 brands (the rest RECALL)',
      plan: few,
      screenId: screens[2] ?? '',
      hourStartsAt: few.startsAt,
    },
    {
      name: '40 brands, two with no ads (gaps)',
      plan: gaps,
      screenId: screens[0] ?? '',
      hourStartsAt: hour,
    },
    { name: '30 slots of 6', plan: odd, screenId: screens[1] ?? '', hourStartsAt: hour + 7200 },
    {
      name: 'no RECALL ads',
      plan: { ...few, recallAds: [] },
      screenId: screens[0] ?? '',
      hourStartsAt: few.startsAt + 3600,
    },
  ].map((r) => ({
    name: r.name,
    plan: {
      slots: r.plan.slots,
      perBrand: r.plan.perBrand,
      brands: r.plan.brands,
      recallAds: r.plan.recallAds,
    },
    screenId: r.screenId,
    hourStartsAt: r.hourStartsAt,
    offset: pocOffset(r.screenId, r.hourStartsAt, r.plan.slots),
    spots: Array.from({ length: 240 }, (_, i) =>
      show(pocSpotAt(r.plan, r.screenId, r.hourStartsAt, i)),
    ),
  }));
  const offsets = Array.from({ length: 24 }, (_, i) => {
    const screenId = `SCR-${String(i * 7919).padStart(8, '0')}`;
    const hourStartsAt = W.startsAt + (i % 6) * 3600;
    return { screenId, hourStartsAt, slots: 40, offset: pocOffset(screenId, hourStartsAt, 40) };
  });
  const covers = [
    W.startsAt - 1,
    W.startsAt,
    W.startsAt + 17 * 3600 + 3599, // 01:59:59 on 2 November
    W.startsAt + 18 * 3600, // 02:00
    W.startsAt + 23 * 3600, // 07:00
    W.startsAt + 24 * 3600, // 08:00 on 2 November
    few.endsAt - 7 * 3600, // 01:00 on 10 December, the last hour before it was switched off
    few.endsAt - 1,
    few.endsAt,
  ].map((t) => ({ t, november: pocPlanCovers(full, t), december: pocPlanCovers(few, t) }));
  return {
    comment:
      'P7.8: the POC month plans a screen gets on down/poc (the newest message wins, whole), the ones it refuses with the reason, and the 240 spots of an hour under a plan for one screen (pocSpotAt): "kind|ref|ad". Made by packages/domain/test/poc-vectors.test.ts (UPDATE_VECTORS=1). The cloud (TypeScript) and the player (Kotlin) both pass these.',
    ok: { text: okText, months: [full.month, few.month], brands: [40, 7] },
    refused,
    rotations,
    offsets,
    covers,
  };
}

describe('POC shared cases (P7.8): the ones the Kotlin player also passes', () => {
  const now = build();
  if (process.env.UPDATE_VECTORS === '1' || !existsSync(FILE))
    writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
  const V = JSON.parse(readFileSync(FILE, 'utf8')) as ReturnType<typeof build>;

  it('the file is what the code does now (regenerate on purpose with UPDATE_VECTORS=1)', () => {
    expect(V).toEqual(now);
  });

  it('the cases cover every refusal and both zones', () => {
    expect(new Set(V.refused.map((r) => r.problem)).size).toBeGreaterThanOrEqual(15);
    const back = parsePocPlans(V.ok.text);
    expect('plans' in back && back.plans.map((p) => p.zone.kind)).toEqual(['circle', 'areas']);
    for (const r of V.rotations) expect(r.spots).toHaveLength(240);
  });
});
