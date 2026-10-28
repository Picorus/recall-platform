// P7.8: the POC package's rules. The rotation is checked hardest: every brand gets exactly its 5 a
// bike-hour and never more, 200 brand plays and 40 RECALL spots, evenly spread; money always adds up.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkEntry } from '../src/ledger.js';
import { judgePlay, type PlayReport } from '../src/plays.js';
import { HITECH_CITY, POC_PAY_ZONE } from '../src/pay-zone.js';
import {
  addMonths,
  businessMonthAt,
  checkPocRules,
  daysInMonth,
  DEFAULT_POC_RULES,
  indiaHourOf,
  isBusinessHour,
  parsePocPlans,
  parsePocRef,
  playsPerBrand,
  pocDayEarned,
  pocDaysOver,
  pocEarnedAfter,
  pocMonthMoney,
  pocMonthCancelled,
  pocMonthPaid,
  POC_TERMS,
  POC_TERMS_VERSION,
  pocMonthWindow,
  pocOffset,
  pocPlanCovers,
  pocPlansText,
  pocPlayProblem,
  pocRef,
  pocScreenSpotAt,
  pocSpotAt,
  type PocPlan,
  type PocPlayContext,
} from '../src/poc.js';
import { checkSetting, DEFAULT_SETTINGS } from '../src/settings.js';
import { DOWN_KINDS } from '../src/screen-link.js';

const brandsOf = (n: number, month = '2026-11'): PocPlan['brands'] =>
  Array.from({ length: n }, (_, i) => ({
    ref: pocRef(`brand-${String(i + 1).padStart(2, '0')}`, month),
    ads: Array.from({ length: 2 + (i % 4) }, (_, k) => `ad-${i + 1}-${k + 1}`),
  }));

const plan = (n: number, slots = 40, perBrand = 5): PocPlan => {
  const w = pocMonthWindow('2026-11');
  return {
    month: '2026-11',
    ...w,
    zone: POC_PAY_ZONE,
    slots,
    perBrand,
    brands: brandsOf(n),
    recallAds: ['recall-1', 'recall-2', 'recall-3'],
  };
};
const HOUR = pocMonthWindow('2026-11').startsAt + 10 * 3600; // 18:00 on 1 Nov

/** The hour's 240 spots on one screen. */
const hourOn = (p: PocPlan, screenId: string, hour = HOUR) =>
  Array.from({ length: 240 }, (_, i) => pocSpotAt(p, screenId, hour, i));

describe('the setting (P7.8.1)', () => {
  it('defaults to 40 brands at ₹2.5 L a month, 200 bikes, up to 3 months: 5 plays each an hour', () => {
    expect(DEFAULT_POC_RULES).toEqual({
      maxBrands: 40,
      feePaise: 25_000_000,
      maxBikes: 200,
      pocMonths: 3,
    });
    expect(playsPerBrand(DEFAULT_POC_RULES)).toBe(5);
    expect(DEFAULT_SETTINGS.poc).toEqual(DEFAULT_POC_RULES);
  });

  it('is checked as typed: whole numbers in range, in plain words', () => {
    expect(checkSetting('poc', { ...DEFAULT_POC_RULES, maxBrands: 25 }).maxBrands).toBe(25);
    expect(() => checkSetting('poc', { ...DEFAULT_POC_RULES, maxBrands: 0 })).toThrow(
      /most brands/,
    );
    expect(() => checkSetting('poc', { ...DEFAULT_POC_RULES, maxBrands: 201 })).toThrow(/1 to 200/);
    expect(() => checkSetting('poc', { ...DEFAULT_POC_RULES, feePaise: 2.5 })).toThrow(/fee/);
    expect(() => checkSetting('poc', { ...DEFAULT_POC_RULES, maxBikes: -1 })).toThrow(/bikes/);
    expect(() => checkSetting('poc', { ...DEFAULT_POC_RULES, pocMonths: 13 })).toThrow(/months/);
    expect(() => checkPocRules(null)).toThrow(/not filled in/);
  });
});

describe('months and references', () => {
  it('names a POC month "poc/<brand>/<YYYY-MM>", and reads only that spelling back', () => {
    expect(pocRef('masala-chai-co', '2026-11')).toBe('poc/masala-chai-co/2026-11');
    expect(parsePocRef('poc/masala-chai-co/2026-11')).toEqual({
      brandId: 'masala-chai-co',
      month: '2026-11',
    });
    for (const bad of [
      'poc/Masala/2026-11',
      'poc/x/2026-13',
      'poc/x/2026-1',
      'poc//2026-11',
      'poc/x/2026-11/',
      'BK-1/hyd/2026-11-01/8',
    ])
      expect(parsePocRef(bad)).toBeUndefined();
    expect(() => pocRef('Bad Brand', '2026-11')).toThrow();
    expect(() => pocRef('x', '2026-1')).toThrow();
  });

  it('a month runs from 08:00 on the 1st to 02:00 on the next 1st (India time)', () => {
    const w = pocMonthWindow('2026-12');
    expect(new Date(w.startsAt * 1000).toISOString()).toBe('2026-12-01T02:30:00.000Z');
    expect(new Date(w.endsAt * 1000).toISOString()).toBe('2026-12-31T20:30:00.000Z');
    // 01:30 on 1 January belongs to 31 December.
    expect(businessMonthAt(w.endsAt - 1800)).toBe('2026-12');
    expect(businessMonthAt(w.startsAt - 1)).toBeUndefined();
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(daysInMonth('2028-02')).toBe(29);
  });

  it('hours start on :30 UTC; business hours are 08:00–02:00', () => {
    const t = Date.parse('2026-11-05T13:47:12Z') / 1000; // 19:17 India time
    expect(new Date(indiaHourOf(t) * 1000).toISOString()).toBe('2026-11-05T13:30:00.000Z');
    expect(isBusinessHour(Date.parse('2026-11-05T21:00:00Z') / 1000)).toBe(false); // 02:30
    expect(isBusinessHour(Date.parse('2026-11-05T20:00:00Z') / 1000)).toBe(true); // 01:30
  });
});

describe('money (P7.8.1): the month is paid before it starts and earned day by day', () => {
  it('fee + 18% GST: ₹2,50,000 + ₹45,000', () => {
    expect(pocMonthMoney(25_000_000, 1_800)).toEqual({
      fee: 25_000_000,
      gst: 4_500_000,
      total: 29_500_000,
    });
  });

  it('the payment balances: money in = held + GST', () => {
    const e = pocMonthPaid({
      ref: 'poc/x/2026-11',
      brandId: 'x',
      fee: 25_000_000,
      gst: 4_500_000,
      paymentId: 'pay_1',
      at: 1,
    });
    expect(checkEntry(e)).toEqual([]);
    expect(e.entryId).toBe('paid:poc/x/2026-11:pay_1');
  });

  it('property: the days of a month always add up to its fee exactly, each entry balanced', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 2026, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        (fee, y, m) => {
          const month = `${y}-${String(m).padStart(2, '0')}`;
          const days = daysInMonth(month);
          let sum = 0;
          let last = 0;
          for (let d = 1; d <= days; d++) {
            const e = pocDayEarned({
              ref: `poc/x/${month}`,
              brandId: 'x',
              feePaise: fee,
              month,
              date: `${month}-${String(d).padStart(2, '0')}`,
              at: 1,
            });
            if (!e) continue;
            expect(checkEntry(e)).toEqual([]);
            const credit = e.postings.find((p) => p.account === 'revenue')?.credit ?? 0;
            expect(credit).toBeGreaterThan(0);
            sum += credit;
            // Never more than its share: the running total is what the month has earned so far.
            expect(sum).toBe(pocEarnedAfter(fee, month, d));
            expect(sum).toBeGreaterThanOrEqual(last);
            last = sum;
          }
          expect(sum).toBe(fee);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a POC cancelled before it started: the month goes back, with its GST, balanced', () => {
    const e = pocMonthCancelled({ ref: 'poc/x/2026-11', brandId: 'x', fee: 100, gst: 18, at: 1 });
    expect(checkEntry(e)).toEqual([]);
    expect(e.postings.find((p) => p.account === 'refunds-payable')?.credit).toBe(118);
    expect(POC_TERMS).toHaveLength(4);
    expect(POC_TERMS_VERSION).toBe(1);
  });

  it('a day is earned when its business day ends (02:00 the next morning)', () => {
    const endOfFirst = pocMonthWindow('2026-11').startsAt + 18 * 3600; // 02:00 on 2 Nov
    expect(pocDaysOver('2026-11', endOfFirst - 1)).toEqual([]);
    expect(pocDaysOver('2026-11', endOfFirst)).toEqual(['2026-11-01']);
    expect(pocDaysOver('2026-11', pocMonthWindow('2026-11').endsAt)).toHaveLength(30);
    expect(() =>
      pocDayEarned({
        ref: 'poc/x/2026-11',
        brandId: 'x',
        feePaise: 100,
        month: '2026-11',
        date: '2026-12-01',
        at: 1,
      }),
    ).toThrow(/not in/);
  });
});

describe('every hour shared (P7.8.2)', () => {
  it('40 brands: each gets exactly 5 of the 200 brand plays; 40 RECALL spots; 240 in all', () => {
    const spots = hourOn(plan(40), 'SCR-0000001A');
    expect(spots).toHaveLength(240);
    const recall = spots.filter((s) => s.kind === 'recall');
    expect(recall).toHaveLength(40);
    spots.forEach((s, i) => expect(s.kind === 'recall').toBe(i % 6 === 5));
    const per = new Map<string, number>();
    for (const s of spots) if (s.kind === 'brand') per.set(s.lineId, (per.get(s.lineId) ?? 0) + 1);
    expect(per.size).toBe(40);
    for (const n of per.values()) expect(n).toBe(5);
  });

  it('property: for any screen, hour and number of brands, nobody gets more than 5, spread evenly', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 40 }),
        (screen, h, n) => {
          const p = plan(n);
          const hour = p.startsAt + h * 3600;
          const spots = hourOn(p, screen, hour);
          const brandIdx = new Map<string, number[]>();
          let k = 0;
          spots.forEach((s, i) => {
            if (i % 6 === 5) {
              expect(s.kind).toBe('recall');
              return;
            }
            if (s.kind === 'brand') brandIdx.set(s.lineId, [...(brandIdx.get(s.lineId) ?? []), k]);
            else expect(s.kind).toBe('recall');
            k += 1;
          });
          expect(k).toBe(200);
          // Every brand of the month, exactly 5, one every 40 brand plays.
          expect(brandIdx.size).toBe(n);
          for (const ks of brandIdx.values()) {
            expect(ks).toHaveLength(5);
            for (let j = 1; j < ks.length; j++) expect((ks[j] ?? 0) - (ks[j - 1] ?? 0)).toBe(40);
          }
          // Slots of brands not there are RECALL's: 40 + 5 × (40 − n) RECALL spots.
          expect(spots.filter((s) => s.kind === 'recall')).toHaveLength(40 + 5 * (40 - n));
          // A brand's ads take turns: never the same ad twice running when it has two or more.
          for (const b of p.brands) {
            const ads = spots
              .filter((s) => s.kind === 'brand' && s.lineId === b.ref)
              .map((s) => s.ad);
            for (const ad of ads) expect(b.ads).toContain(ad);
            if (b.ads.length > 1)
              for (let j = 1; j < ads.length; j++) expect(ads[j]).not.toBe(ads[j - 1]);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('a brand with no ads keeps its slot for RECALL: nobody else moves', () => {
    const p = plan(3);
    const gap = { ...p, brands: p.brands.map((b, i) => (i === 1 ? { ...b, ads: [] } : b)) };
    const before = hourOn(p, 'SCR-0000003C');
    const after = hourOn(gap, 'SCR-0000003C');
    after.forEach((s, i) => {
      const was = before[i];
      if (was?.kind === 'brand' && was.lineId === p.brands[1]?.ref) expect(s.kind).toBe('recall');
      else expect(s).toEqual(was);
    });
  });

  it("a different setting: 30 slots of 6 plays (180), the 20 left over are RECALL's", () => {
    const spots = hourOn(plan(30, 30, 6), 'SCR-0000002B');
    expect(spots.filter((s) => s.kind === 'brand')).toHaveLength(180);
    expect(spots.filter((s) => s.kind === 'recall')).toHaveLength(60);
  });

  it('bikes start their rotation at different slots, so a street shows different brands', () => {
    const firsts = new Set(
      Array.from({ length: 50 }, (_, i) => {
        const s = pocSpotAt(plan(40), `SCR-${String(i).padStart(8, '0')}`, HOUR, 0);
        return s.kind === 'brand' ? s.lineId : 'recall';
      }),
    );
    expect(firsts.size).toBeGreaterThan(20);
    expect(pocOffset('SCR-1', HOUR, 40)).toBe(pocOffset('SCR-1', HOUR, 40));
    expect(pocOffset('SCR-1', HOUR, 40)).toBeLessThan(40);
  });

  it('no RECALL ads: an empty ad (the slate); spots count from 0', () => {
    const p = { ...plan(0), recallAds: [] };
    expect(pocSpotAt(p, 'S', HOUR, 0)).toEqual({ kind: 'recall', ad: '' });
    expect(() => pocSpotAt(p, 'S', HOUR, -1)).toThrow(/count from 0/);
  });

  it('outside the POC zone in a POC hour: blank, every one of the 240 (P2.5)', () => {
    const p = plan(40);
    const t = HOUR + 100;
    const out = Array.from({ length: 240 }, (_, i) => pocScreenSpotAt(p, 'SCR-1', t, i, false));
    expect(out.every((x) => x?.kind === 'blank')).toBe(true);
    const inside = Array.from({ length: 240 }, (_, i) => pocScreenSpotAt(p, 'SCR-1', t, i, true));
    expect(inside).toEqual(hourOn(p, 'SCR-1'));
    // At night the POC plan does not cover the hour: the usual plans.
    expect(pocScreenSpotAt(p, 'SCR-1', HOUR + 9 * 3600, 0, false)).toBeUndefined();
  });

  it('a plan plays only inside its window and in business hours', () => {
    const p = plan(1);
    expect(pocPlanCovers(p, p.startsAt)).toBe(true);
    expect(pocPlanCovers(p, p.startsAt - 1)).toBe(false);
    expect(pocPlanCovers(p, p.startsAt + 19 * 3600)).toBe(false); // 03:00
    expect(pocPlanCovers(p, p.endsAt)).toBe(false);
    expect(pocPlanCovers({ ...p, endsAt: p.startsAt + 3600 }, p.startsAt + 3600)).toBe(false);
  });
});

describe('the message the screens get (down/poc)', () => {
  it('reads back what it wrote; the screens listen on down/poc', () => {
    expect(DOWN_KINDS).toContain('poc');
    const p = plan(3);
    const text = pocPlansText([p], 1_793_620_000_000);
    const back = parsePocPlans(text);
    expect('plans' in back && back.plans[0]).toEqual(JSON.parse(JSON.stringify(p)));
  });

  it('refuses what a screen must not take, with a reason', () => {
    const ok = JSON.parse(pocPlansText([plan(2)], 1)) as {
      plans: Record<string, unknown>[];
    };
    const bad = (f: (p: Record<string, unknown>) => void) => {
      const x = structuredClone(ok);
      f(x.plans[0] ?? {});
      const r = parsePocPlans(JSON.stringify(x));
      return 'problem' in r ? r.problem : 'taken';
    };
    expect(bad((p) => (p.month = '2026-13'))).toBe('bad month');
    expect(bad((p) => (p.startsAt = (p.startsAt as number) + 1))).toBe('bad start time');
    expect(bad((p) => (p.endsAt = (p.endsAt as number) + 1))).toBe('bad end time');
    expect(bad((p) => (p.slots = 0))).toBe('bad slots');
    expect(bad((p) => (p.brands = [{ ref: 'poc/x/2026-12', ads: ['a'] }]))).toBe('bad brand ref');
    expect(
      bad((p) => (p.brands = [{ ref: 'poc/x/2026-11', ads: ['1', '2', '3', '4', '5', '6'] }])),
    ).toBe('bad brand ads');
    // A brand with no ads (not paid yet, or none approved) keeps its slot: taken.
    expect(bad((p) => (p.brands = [{ ref: 'poc/x/2026-11', ads: [] }]))).toBe('taken');
    expect(bad((p) => (p.zone = { kind: 'circle', centre: { lat: 99, lng: 0 }, radiusM: 1 }))).toBe(
      'bad zone centre',
    );
    expect(bad((p) => (p.extra = 1))).toBe('wrong plan fields');
    expect(parsePocPlans('{')).toEqual({ problem: 'not a POC plans list' });
    expect(() => pocPlansText([plan(1), plan(1)], 1)).toThrow(/twice/);
  });
});

describe('counting a POC play (P7.8.2)', () => {
  const p = plan(2);
  const ref = p.brands[0]?.ref ?? '';
  const ctx = (o: Partial<PocPlayContext> = {}): PocPlayContext => ({
    on: true,
    month: { ref, paid: true, ads: ['ad-1-1', 'ad-1-2'], startsAt: p.startsAt, endsAt: p.endsAt },
    zone: POC_PAY_ZONE,
    countedThisHour: 0,
    perBrand: 5,
    ...o,
  });
  const play = { slot: 'brand', ref, adId: 'ad-1-1', startAt: HOUR + 60 };
  const near = { lat: HITECH_CITY.lat + 0.01, lng: HITECH_CITY.lng };
  const far = { lat: HITECH_CITY.lat + 0.5, lng: HITECH_CITY.lng };
  const out = { kind: 'outside' } as const;

  it('counts when on, paid, its ad, in the zone, in its month, under 5 this bike-hour', () => {
    expect(pocPlayProblem(play, near, out, ctx())).toBeUndefined();
    expect(pocPlayProblem(play, near, out, ctx({ on: false }))).toBe('the POC was not on');
    const month = { ref, paid: false, ads: ['ad-1-1'], startsAt: p.startsAt, endsAt: p.endsAt };
    expect(pocPlayProblem(play, near, out, ctx({ month }))).toBe('POC month not paid');
    expect(pocPlayProblem({ ...play, adId: 'other' }, near, out, ctx())).toBe('not one of its ads');
    expect(pocPlayProblem(play, far, out, ctx())).toBe('outside the POC zone');
    expect(pocPlayProblem(play, near, out, ctx({ countedThisHour: 5 }))).toBe(
      'more than 5 this bike-hour',
    );
    expect(pocPlayProblem({ ...play, startAt: p.startsAt - 60 }, near, out, ctx())).toBe(
      'outside its month',
    );
    expect(pocPlayProblem({ ...play, startAt: HOUR + 9 * 3600 }, near, out, ctx())).toBe(
      'outside business hours',
    );
    expect(pocPlayProblem({ ...play, slot: 'make-up' }, near, out, ctx())).toBe('make-up spot');
    expect(pocPlayProblem(play, near, out, ctx({ month: undefined }))).toBe('not a POC month');
  });

  it('through judgePlay: the play counts "inside" its POC month; the usual checks still come first', () => {
    const report: PlayReport = {
      kind: 'play',
      keyId: 'k1',
      slot: 'brand',
      ref,
      adId: 'ad-1-1',
      startAt: HOUR + 60,
      lengthS: 15,
      latE6: Math.round(near.lat * 1e6),
      lngE6: Math.round(near.lng * 1e6),
      accuracyM: 5,
      place: 'outside',
      people: 3,
      sig: 'x'.repeat(40),
    };
    const base = { receivedAt: HOUR + 120, signature: 'ok' as const, neighbours: [], areas: [] };
    const j = judgePlay(report, { ...base, line: undefined, poc: ctx() });
    expect(j).toMatchObject({ count: { counts: 'inside', lineId: ref } });
    expect(judgePlay(report, { ...base, line: undefined })).toMatchObject({
      count: { counts: 'no', reason: 'not a POC month' },
    });
    expect(
      judgePlay({ ...report, accuracyM: 500 }, { ...base, line: undefined, poc: ctx() }),
    ).toMatchObject({ count: { counts: 'no', reason: 'position not accurate enough' } });
    expect(judgePlay(report, { ...base, signature: 'bad', line: undefined, poc: ctx() })).toEqual({
      refused: 'bad signature',
    });
  });
});
