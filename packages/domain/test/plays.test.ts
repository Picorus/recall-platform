import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { launchAreas } from '../src/launch-areas.js';
import {
  DEFAULT_PLAY_RULES as RULES,
  judgePlay,
  lineIdOf,
  lineTotals,
  playBytes,
  type CountedPlay,
  type PlayContext,
  type PlayReport,
} from '../src/plays.js';
import { checkReport } from '../src/screen-reports.js';

const AREAS = launchAreas('2027-08-01T00:00:00.000Z').map((a) => ({ ...a, draft: false }));
// Madhapur, Tue 24 Aug 2027, 6–7 pm India time.
const HOUR = Date.UTC(2027, 7, 24, 12, 30) / 1000;
const LINE = lineIdOf('BK-1', 'hyd-madhapur', '2027-08-24', 18);
const play = (over: Partial<PlayReport> = {}): PlayReport => ({
  kind: 'play',
  keyId: 'k1',
  slot: 'brand',
  ref: LINE,
  adId: 'ad-1',
  startAt: HOUR + 600,
  lengthS: 15,
  latE6: 17_448_000, // inside Madhapur
  lngE6: 78_395_000,
  accuracyM: 8,
  place: 'inside:hyd-madhapur@1',
  people: 3,
  sig: 'MEUCIQDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  ...over,
});
const ctx = (over: Partial<PlayContext> = {}): PlayContext => ({
  receivedAt: HOUR + 700,
  signature: 'ok',
  neighbours: [],
  areas: AREAS,
  line: { lineId: LINE, areaId: 'hyd-madhapur', startsAt: HOUR, endsAt: HOUR + 3600, plays: 1000 },
  ...over,
});
const verdict = (p: PlayReport, c: PlayContext = ctx()) => {
  const r = judgePlay(p, c);
  return r.refused ?? (r.count.counts === 'no' ? r.count.reason : r.count.counts);
};

describe('the play record (P1.5.1)', () => {
  it('the signed bytes are fixed: one field a line, whole numbers only', () => {
    expect(playBytes('scr-7', 42, play())).toBe(
      [
        'RECALL-PLAY-1',
        'scr-7',
        '42',
        'k1',
        'brand',
        'BK-1/hyd-madhapur/2027-08-24/18',
        'ad-1',
        String(HOUR + 600),
        '15',
        '17448000',
        '78395000',
        '8',
        'inside:hyd-madhapur@1',
        '3',
      ].join('\n'),
    );
  });

  it('a play travels as a screen report and its shape is checked', () => {
    expect(checkReport(play())).toBeUndefined();
    expect(checkReport(play({ ref: 'a\nb' }))).toBe('bad reference');
    expect(checkReport(play({ latE6: 17.448 }))).toBe('bad latitude');
    expect(checkReport(play({ slot: 'other' as PlayReport['slot'] }))).toBe('bad slot');
    expect(checkReport(play({ sig: '' }))).toBe('bad signature format');
    expect(checkReport(play({ slot: 'recall', ref: '' }))).toBeUndefined();
    expect(checkReport(play({ ref: '' }))).toBe('bad reference');
  });
});

describe("the cloud's checks (P1.5.2)", () => {
  it('a good play inside the area counts', () => {
    expect(verdict(play())).toBe('inside');
  });

  it('refused: unknown key, bad signature, starting in the future, closer than 15 s to another play', () => {
    expect(verdict(play(), ctx({ signature: 'unknown key' }))).toBe('unknown key');
    expect(verdict(play(), ctx({ signature: 'bad' }))).toBe('bad signature');
    expect(verdict(play(), ctx({ neighbours: [HOUR + 600 - 14] }))).toBe('overlaps another play');
    expect(verdict(play(), ctx({ neighbours: [HOUR + 600 - 15, HOUR + 615] }))).toBe('inside');
  });

  it('property: one screen never has more than 240 plays accepted in an hour (P7.3)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 3599 }), { maxLength: 600 }), (starts) => {
        // Judged one by one as uploads arrive, each against the plays already accepted.
        const taken: number[] = [];
        for (const t of starts) {
          const near = taken.filter((x) => Math.abs(x - (HOUR + t)) < RULES.spotSeconds);
          const r = judgePlay(play({ startAt: HOUR + t }), ctx({ neighbours: near }));
          if (!r.refused) taken.push(HOUR + t);
        }
        expect(taken.length).toBeLessThanOrEqual(3600 / RULES.spotSeconds);
      }),
    );
  });

  it('the cloud decides where the play was, whatever the screen thought', () => {
    // The screen says inside Madhapur, but the position is in Kondapur, or far from every area.
    expect(verdict(play({ latE6: 17_467_000, lngE6: 78_357_000 }))).toBe('inside another area');
    expect(verdict(play({ latE6: 17_300_000, lngE6: 78_600_000 }))).toBe("outside the line's area");
    // Just outside Madhapur's border: the edge zone.
    expect(verdict(play({ latE6: 17_458_300, place: 'inside:hyd-madhapur@1' }))).toBe('edge');
  });

  it('a screen clock running ahead: the play is kept but not counted', () => {
    expect(verdict(play({ startAt: HOUR + 700 + 121 }))).toBe('screen clock ahead');
    expect(verdict(play({ startAt: HOUR + 700 + 120 }))).toBe('inside');
  });

  it('a draft correction of an area never hides the published area', () => {
    const draft = AREAS.filter((a) => a.areaId === 'hyd-madhapur').map((a) => ({
      ...a,
      version: 2,
      draft: true,
      validFrom: '2027-08-01T00:00:00.000Z',
    }));
    expect(verdict(play(), ctx({ areas: [...AREAS, ...draft] }))).toBe('inside');
  });

  it('a play inside a neighbouring area is never the line’s edge play, even where the edge zone reaches in (P1.1.7)', () => {
    // Hitech City redrawn to share Madhapur's west border (78.387): Madhapur's edge zone now lies
    // inside Hitech City. A play 10 m into Hitech City is Hitech City's, not Madhapur's edge.
    const near = AREAS.map((a) =>
      a.areaId === 'hyd-hitech-city'
        ? { ...a, ring: a.ring.map((q) => ({ ...q, lng: q.lng > 78.38 ? 78.387 : q.lng })) }
        : a,
    );
    const p = play({ lngE6: 78_386_900 });
    expect(verdict(p, ctx({ areas: near }))).toBe('inside another area');
    const r = judgePlay(p, ctx({ areas: near }));
    expect(r.refused ?? r.cloudPlace).toBe('inside:hyd-hitech-city@1');
    // North of Hitech City (it ends at 17.455) the edge zone is outside every area: it counts.
    expect(verdict(play({ latE6: 17_456_000, lngE6: 78_386_900 }), ctx({ areas: near }))).toBe(
      'edge',
    );
    // As before when the edge zone only meets the neighbour's edge zone (the launch areas' gap).
    expect(verdict(p)).toBe('edge');
  });

  it('property: a play counts for one area at most, and never as an edge play inside another area', () => {
    const near = AREAS.map((a) =>
      a.areaId === 'hyd-hitech-city'
        ? { ...a, ring: a.ring.map((q) => ({ ...q, lng: q.lng > 78.38 ? 78.387 : q.lng })) }
        : a,
    );
    const lineOf = (areaId: string) => ({
      lineId: lineIdOf('BK-1', areaId, '2027-08-24', 18),
      areaId,
      startsAt: HOUR,
      endsAt: HOUR + 3600,
      plays: 1000,
    });
    const ids = near.map((a) => a.areaId);
    fc.assert(
      fc.property(
        fc.integer({ min: 17_430_000, max: 17_465_000 }),
        fc.integer({ min: 78_365_000, max: 78_410_000 }),
        (latE6, lngE6) => {
          const counts = ids.flatMap((id) => {
            const l = lineOf(id);
            const r = judgePlay(
              play({ latE6, lngE6, ref: l.lineId }),
              ctx({ areas: near, line: l }),
            );
            return !r.refused && r.count.counts !== 'no' ? [{ id, counts: r.count.counts, r }] : [];
          });
          expect(counts.filter((c) => c.counts === 'inside').length).toBeLessThanOrEqual(1);
          for (const c of counts) {
            const cloud = c.r.refused ? '' : c.r.cloudPlace;
            if (c.counts === 'edge') expect(cloud.startsWith('inside:')).toBe(false);
            if (c.counts === 'inside') expect(cloud).toBe(`inside:${c.id}@1`);
          }
          // Inside some area: only that area's line counts it.
          if (counts.some((c) => c.counts === 'inside')) expect(counts.length).toBe(1);
        },
      ),
      { numRuns: 3_000 },
    );
  });

  it('kept but not counted: cut short, poor GPS, another hour, not a sold line, late, not a brand spot', () => {
    expect(verdict(play({ lengthS: 13 }))).toBe('cut short');
    expect(verdict(play({ accuracyM: 51 }))).toBe('position not accurate enough');
    expect(verdict(play({ startAt: HOUR - 15 }))).toBe('outside its hour');
    expect(verdict(play({ startAt: HOUR + 3600 }), ctx({ receivedAt: HOUR + 3700 }))).toBe(
      'outside its hour',
    );
    expect(verdict(play(), ctx({ line: undefined }))).toBe('not a sold booking line');
    expect(verdict(play({ ref: lineIdOf('BK-2', 'hyd-madhapur', '2027-08-24', 18) }))).toBe(
      'not a sold booking line',
    );
    expect(verdict(play(), ctx({ receivedAt: HOUR + 600 + RULES.maxAgeSeconds + 1 }))).toBe(
      'arrived too late',
    );
    expect(verdict(play({ slot: 'recall', ref: '' }))).toBe('recall spot');
  });

  it('an area switched off at that time does not count', () => {
    const off = AREAS.map((a) =>
      a.areaId === 'hyd-madhapur'
        ? { ...a, version: 2, active: false, validFrom: '2027-08-20T00:00:00.000Z' }
        : a,
    );
    expect(verdict(play(), ctx({ areas: [...AREAS, ...off.filter((a) => a.version === 2)] }))).toBe(
      "outside the line's area",
    );
  });
});

describe('counting per line (P1.5.3–4)', () => {
  const p = (
    screenId: string,
    startAt: number,
    counts: 'inside' | 'edge',
    people = 0,
  ): CountedPlay => ({
    screenId,
    startAt,
    counts,
    people,
  });

  it('edge plays count up to 10% of the promise; inside plays all count', () => {
    const inside = Array.from({ length: 950 }, (_, i) => p(`s${i % 10}`, HOUR + i * 15, 'inside'));
    const edge = Array.from({ length: 150 }, (_, i) => p(`e${i % 3}`, HOUR + i * 15, 'edge'));
    const t = lineTotals(1000, [...inside, ...edge]);
    expect([t.plays, t.inside, t.edge, t.edgeCounted]).toEqual([1050, 950, 150, 100]);
  });

  it('different bikes and minutes inside are counted from counted plays; no people in the totals', () => {
    const t = lineTotals(1000, [
      p('a', HOUR, 'inside', 4),
      p('a', HOUR + 15, 'inside', 2),
      p('a', HOUR + 60, 'inside', 1),
      p('b', HOUR, 'edge', 10),
    ]);
    expect(t).toEqual({
      plays: 4,
      inside: 3,
      edge: 1,
      edgeCounted: 1,
      bikes: 2,
      minutes: 2,
    });
  });

  it('property: the same plays give the same totals in any order, and never more than inside + the edge share', () => {
    const arb = fc.array(
      fc.record({
        screenId: fc.constantFrom('a', 'b', 'c', 'd'),
        startAt: fc.integer({ min: HOUR, max: HOUR + 3599 }),
        counts: fc.constantFrom('inside' as const, 'edge' as const),
        people: fc.integer({ min: 0, max: 20 }),
      }),
      { maxLength: 300 },
    );
    fc.assert(
      fc.property(arb, fc.integer({ min: 0, max: 2000 }), (plays, promised) => {
        const a = lineTotals(promised, plays);
        const b = lineTotals(promised, [...plays].reverse());
        expect(a).toEqual(b);
        expect(a.edgeCounted).toBeLessThanOrEqual(Math.floor(promised / 10));
        expect(a.plays).toBe(a.inside + a.edgeCounted);
        expect(a.plays).toBeLessThanOrEqual(plays.length);
      }),
      { numRuns: 300 },
    );
  });
});
