// Writes test-vectors/screen-plan.json from the cloud's own code (P2.6.2): the messages a screen gets
// to choose what to play, their refusals, and the screen's own pick for 200 screens. The Kotlin player
// must pass the same file. Run from packages/domain: npx tsx scripts/screen-plan-vectors.ts
import { writeFileSync } from 'node:fs';
import { buildHourPlan, fallbackPick, fnv1a32, hash32, type HourPlan } from '../src/scheduler.js';
import {
  areasText,
  assignText,
  indiaHourStart,
  parseAreas,
  parseAssign,
  parsePlans,
  plansText,
} from '../src/screen-plan.js';

const MADE = 1793620000000;
const DATE = '2026-11-02';
const start = (h: number) => {
  const s = indiaHourStart(DATE, h);
  if (s === undefined) throw new Error('bad hour');
  return s;
};

const areas = [
  {
    areaId: 'hyd-madhapur',
    version: 3,
    edgeMeters: 300,
    active: true,
    ring: [
      { lat: 17.44, lng: 78.38 },
      { lat: 17.44, lng: 78.4 },
      { lat: 17.455, lng: 78.4 },
      { lat: 17.455, lng: 78.38 },
    ],
  },
  {
    areaId: 'hyd-kondapur',
    version: 1,
    edgeMeters: 250,
    active: false,
    ring: [
      { lat: 17.457, lng: 78.345 },
      { lat: 17.457, lng: 78.369 },
      { lat: 17.478, lng: 78.357 },
    ],
  },
];

type In = Parameters<typeof buildHourPlan>[0];
const plan = (areaId: string, startHour: number, o: Partial<In>, revision = 1): HourPlan => ({
  ...buildHourPlan({
    areaId,
    date: DATE,
    startHour,
    startsAt: start(startHour),
    paid: [],
    makeUps: [],
    trials: [],
    aggregator: [],
    recallAds: ['r1', 'r2', 'r3'],
    ...o,
  }),
  revision,
});
const plans = [
  // Paid lines (one with no bikes sold), make-ups owed in RECALL's spots, a trial, an aggregator.
  plan(
    'hyd-madhapur',
    18,
    {
      paid: [
        { lineId: 'L-ponnu', brandId: 'B1', ads: ['a1', 'a2', 'a3'], bikes: 3 },
        { lineId: 'L-chai', brandId: 'B2', ads: ['c1', 'c2'], bikes: 1 },
        { lineId: 'L-none', brandId: 'B6', ads: ['n1', 'n2'], bikes: 0 },
        { lineId: 'L-big', brandId: 'B5', ads: ['g1', 'g2', 'g3', 'g4', 'g5'], bikes: 6 },
      ],
      makeUps: [
        { lineId: 'M-old', brandId: 'B3', ads: ['m1'], plays: 120 },
        { lineId: 'M-two', brandId: 'B7', ads: ['m2', 'm3'], plays: 40 },
        { lineId: 'M-zero', brandId: 'B8', ads: ['m4'], plays: 0 },
      ],
      trials: [{ lineId: 'T-try', brandId: 'B4', ads: ['t1', 't2'], bikes: 1 }],
      aggregator: [{ id: 'G-agg', ads: ['x1'], plays: 40 }],
    },
    2,
  ),
  // No paid lines: make-ups take whole bikes (by plays owed); trials wait.
  plan('hyd-madhapur', 19, {
    makeUps: [
      { lineId: 'M-only', brandId: 'B3', ads: ['m1', 'm2'], plays: 300 },
      { lineId: 'M-less', brandId: 'B9', ads: ['m5'], plays: 100 },
    ],
    trials: [{ lineId: 'T-two', brandId: 'B4', ads: ['t1', 't2'], bikes: 2 }],
    aggregator: [
      { id: 'G-a', ads: ['x1'], plays: 10 },
      { id: 'G-b', ads: ['x2'], plays: 30 },
    ],
  }),
  // Trials only; RECALL's spots to aggregators only.
  plan('hyd-kondapur', 18, {
    trials: [
      { lineId: 'T-k', brandId: 'B4', ads: ['t1', 't2'], bikes: 1 },
      { lineId: 'T-l', brandId: 'B10', ads: ['t3', 't4'], bikes: 2 },
      { lineId: 'T-m', brandId: 'B11', ads: ['t5', 't6'], bikes: 3 },
    ],
    aggregator: [
      { id: 'G-x', ads: ['x1'], plays: 20 },
      { id: 'G-y', ads: ['x2'], plays: 20 },
      { id: 'G-z', ads: ['x3'], plays: 0 },
    ],
  }),
  // After midnight (00:00 and 01:00 belong to the day before): nothing sold, then one line.
  plan('hyd-kondapur', 24, {}),
  plan('hyd-kondapur', 25, {
    paid: [{ lineId: 'L-late', brandId: 'B12', ads: ['l1', 'l2'], bikes: 1 }],
    aggregator: [
      { id: 'G-p', ads: ['x1'], plays: 5 },
      { id: 'G-q', ads: ['x2'], plays: 15 },
    ],
  }),
];

const screens = Array.from(
  { length: 200 },
  (_, i) =>
    `SCR-${String((i * 7919) % 10000000).padStart(7, '0')}${'ABCDEFGHJKMNPQRSTVWXYZ'[i % 22]}`,
);
const picks = plans.map((p) => ({
  areaId: p.areaId,
  startsAt: p.startsAt,
  carries: screens.map((s) => {
    const c = fallbackPick(p, s);
    return [c.lineId ?? null, c.spotId ?? null];
  }),
}));

const h18 = start(18);
const assign = [
  { areaId: 'hyd-madhapur', startsAt: h18, carry: { lineId: 'L-ponnu', spotId: 'M-old' } },
  { areaId: 'hyd-madhapur', startsAt: h18, carry: { lineId: undefined, spotId: undefined } },
];
const assignJson = (o: string) => `{"v":1,"made":${MADE},"areaId":"hyd-a","startsAt":${h18}${o}}`;

const aText = areasText(areas, MADE);
const pText = plansText(plans, MADE);
const ring = '[[17.44,78.38],[17.44,78.4],[17.455,78.4]]';
const area = (o = '') =>
  `{"v":1,"made":${MADE},"areas":[{"areaId":"hyd-a","version":1,"edgeMeters":300,"active":true,"ring":${ring}${o}}]}`;
const pl = (JSON.parse(pText) as { plans: Record<string, unknown>[] }).plans[0] as {
  lines: Record<string, unknown>[];
  spotDemands: Record<string, unknown>[];
};
const planWith = (o: object) => JSON.stringify({ v: 1, made: MADE, plans: [{ ...pl, ...o }] });
const r = (kind: 'areas' | 'plan' | 'assign', text: string, problem: string) => ({
  kind,
  text,
  problem,
});
const refused = [
  r('areas', 'nope', 'not an areas list'),
  r('areas', `{"v":2,"made":${MADE},"areas":[]}`, 'unknown version'),
  r('areas', `{"v":1,"made":0,"areas":[]}`, 'bad list time'),
  r('areas', `{"v":1,"made":${MADE},"areas":{}}`, 'bad list'),
  r('areas', area(',"extra":1'), 'wrong area fields'),
  r('areas', area().replace('"hyd-a"', '"Hyd A"'), 'bad area id'),
  r('areas', area().replace('"version":1', '"version":0'), 'bad area version'),
  r('areas', area().replace('"version":1', '"version":2147483648'), 'bad area version'),
  r('areas', area().replace('"edgeMeters":300', '"edgeMeters":2001'), 'bad edge zone'),
  r('areas', area().replace('"active":true', '"active":1'), 'bad on/off'),
  r('areas', area().replace(ring, '[[17.44,78.38],[17.44,78.4]]'), 'bad shape'),
  r('areas', area().replace(ring, '[[17.44,78.38],[17.44,78.4],[91,78.4]]'), 'bad corner'),
  r('areas', area().replace(ring, '[[17.44,78.38],[17.44,78.4],["17.4",78.4]]'), 'bad corner'),
  r('areas', area().replace(ring, '[[17.44,78.38],[17.44,78.4],[17.4]]'), 'bad corner'),
  r(
    'areas',
    JSON.stringify({
      v: 1,
      made: MADE,
      areas: [0, 0].map(() => JSON.parse(areasText(areas.slice(0, 1), MADE)).areas[0]),
    }),
    'an area listed twice',
  ),
  // Not strict JSON: both sides refuse the whole message.
  r('areas', area().replace('"active":true', '"active":TRUE'), 'not an areas list'),
  r('areas', area().replace('[17.44,78.38]', '[17.44,78.38f]'), 'not an areas list'),
  r('areas', area().replace('[17.44,78.38]', '[17.44,.5]'), 'not an areas list'),
  r('plan', 'nope', 'not a plans list'),
  r('plan', `{"v":1,"made":${MADE},"plans":7}`, 'bad list'),
  r('plan', planWith({ extra: 1 }), 'wrong plan fields'),
  r('plan', planWith({ areaId: 'X' }), 'bad area id'),
  r('plan', planWith({ date: '2-11-2026' }), 'bad date'),
  r('plan', planWith({ startHour: 26 }), 'bad start hour'),
  r('plan', planWith({ startsAt: h18 + 1800 }), 'bad start time'),
  r('plan', planWith({ startsAt: h18 + 3600 }), 'bad start time'),
  r('plan', planWith({ date: '2026-02-30', startsAt: h18 }), 'bad start time'),
  r('plan', planWith({ revision: 0 }), 'bad revision'),
  r('plan', planWith({ recallAds: ['r 1'] }), 'bad RECALL ads'),
  r('plan', planWith({ lines: 'none' }), 'bad list'),
  r('plan', planWith({ lines: [{ ...pl.lines[0], extra: 1 }] }), 'wrong line fields'),
  r('plan', planWith({ lines: [{ ...pl.lines[0], kind: 'gift' }] }), 'bad line kind'),
  r('plan', planWith({ lines: [pl.lines[0], pl.lines[0]] }), 'bad line id'),
  r('plan', planWith({ lines: [{ ...pl.lines[0], ads: [] }] }), 'bad line ads'),
  r('plan', planWith({ lines: [{ ...pl.lines[0], bikes: -1 }] }), 'bad line numbers'),
  r('plan', planWith({ spotDemands: [{ ...pl.spotDemands[0], extra: 1 }] }), 'wrong spot fields'),
  r('plan', planWith({ spotDemands: [{ ...pl.spotDemands[0], id: 'a b' }] }), 'bad spot id'),
  r('plan', planWith({ spotDemands: [{ ...pl.spotDemands[0], kind: 'brand' }] }), 'bad spot kind'),
  r(
    'plan',
    planWith({ spotDemands: [{ ...pl.spotDemands[0], ads: ['a', 'b', 'c', 'd', 'e', 'f'] }] }),
    'bad spot ads',
  ),
  r('plan', planWith({ spotDemands: [{ ...pl.spotDemands[0], plays: 1.5 }] }), 'bad spot plays'),
  r('plan', JSON.stringify({ v: 1, made: MADE, plans: [pl, pl] }), 'an area-hour listed twice'),
  r('assign', 'nope', 'not an assignment'),
  r('assign', assignJson(',"lineId":"L 1","spotId":null'), 'bad line id'),
  r('assign', assignJson(',"lineId":null,"spotId":7'), 'bad spot id'),
  r(
    'assign',
    assignJson(',"lineId":null,"spotId":null').replace(`${h18}`, `${h18 + 1800}`),
    'bad start time',
  ),
  r(
    'assign',
    assignJson(',"lineId":null,"spotId":null').replace('"hyd-a"', 'hyd'),
    'not an assignment',
  ),
  r(
    'assign',
    assignJson(',"lineId":null,"spotId":null').replace(`${MADE}`, `0${MADE}`),
    'not an assignment',
  ),
];
const parse = { areas: parseAreas, plan: parsePlans, assign: parseAssign };
for (const x of refused) {
  const got = parse[x.kind](x.text);
  if (!('problem' in got) || got.problem !== x.problem)
    throw new Error(`refusal "${x.problem}" gave ${JSON.stringify(got).slice(0, 200)}`);
}
// Number forms that are plain JSON for the same whole number: both sides take them.
const forms = [`${MADE}`, `${MADE}.0`, '1.79362e12', '179362e7'].map((made) => ({
  text: assignJson(',"lineId":null,"spotId":null').replace(`${MADE}`, made),
  made: MADE,
}));
for (const f of forms) {
  const got = parseAssign(f.text);
  if ('problem' in got || got.made !== MADE) throw new Error(`form ${f.text} not taken`);
}

writeFileSync(
  'test-vectors/screen-plan.json',
  `${JSON.stringify(
    {
      comment:
        "P2.6: what the cloud sends a screen to choose what to play (areas, hour plans, the live assignment), and the screen's own pick without an assignment (scheduler.ts fallbackPick). Carries: [lineId, spotId], null = RECALL's own. Made by scripts/screen-plan-vectors.ts. The cloud (TypeScript) and the player (Kotlin) both pass these.",
      made: MADE,
      areas: { text: aText, parsed: (parseAreas(aText) as { areas: unknown }).areas },
      plans: { text: pText, parsed: (parsePlans(pText) as { plans: unknown }).plans },
      assign: assign.map((a) => ({
        text: assignText(a, MADE),
        areaId: a.areaId,
        startsAt: a.startsAt,
        lineId: a.carry.lineId ?? null,
        spotId: a.carry.spotId ?? null,
      })),
      forms,
      refused,
      hashes: [
        '',
        'a',
        'SCR-0123456Z',
        'sim-1',
        'sim-2',
        'hyd-madhapur|2026-11-02|18',
        'é漢🙂',
      ].map((s) => ({ s, fnv1a32: fnv1a32(s), hash32: hash32(s) })),
      screens,
      picks,
    },
    null,
    2,
  )}\n`,
);
console.log(
  'screen-plan.json:',
  picks
    .map(
      (p) =>
        `${new Set(p.carries.map((c) => c[0])).size} lines/${new Set(p.carries.map((c) => c[1])).size} spots`,
    )
    .join(', '),
);
