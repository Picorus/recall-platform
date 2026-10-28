// P4.5: the days a rider picks on Earnings (quick picks, the calendar, a from–to pick that never
// passes 92 days or today), and P4.4: drawing his small map.
import { checkDayRange } from '@recall/domain';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  canTap,
  daysIn,
  earliestDay,
  monthGrid,
  mondayOf,
  presetOf,
  presetRange,
  PRESETS,
  RANGE_MAX_DAYS,
  rangeText,
  shiftMonth,
  tapDay,
} from '../../src/dates';
import { ago, pathOf, viewOf } from '../../src/map-math';

// Wednesday 28 October 2026.
const TODAY = '2026-10-28';

describe('quick picks (P4.5)', () => {
  it('today, yesterday, this week, last week, this month', () => {
    expect(presetRange('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(presetRange('yesterday', TODAY)).toEqual({ from: '2026-10-27', to: '2026-10-27' });
    expect(presetRange('thisWeek', TODAY)).toEqual({ from: '2026-10-26', to: TODAY });
    expect(presetRange('lastWeek', TODAY)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(presetRange('thisMonth', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
    // On a Monday "this week" is just today; on the 1st "this month" is too.
    expect(presetRange('thisWeek', '2026-10-26')).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(presetRange('lastWeek', '2026-11-01')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(presetRange('yesterday', '2027-01-01')).toEqual({
      from: '2026-12-31',
      to: '2026-12-31',
    });
  });

  it('every quick pick, on any day, is one the server accepts', () => {
    for (let i = 0; i < 800; i++) {
      const today = addDays('2026-01-01', i);
      for (const p of PRESETS) {
        const r = presetRange(p, today);
        expect(checkDayRange(r.from, r.to, today), `${p} on ${today}`).toEqual({ ok: true });
        expect(presetOf(r, today)).toBeDefined();
      }
    }
    expect(presetOf({ from: '2026-10-02', to: TODAY }, TODAY)).toBeUndefined();
  });

  it('day sums and words', () => {
    expect(daysIn({ from: TODAY, to: TODAY })).toBe(1);
    expect(daysIn({ from: '2026-10-01', to: '2026-10-31' })).toBe(31);
    expect(daysIn({ from: '2026-03-28', to: '2026-03-30' })).toBe(3);
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
    expect(rangeText({ from: '2026-10-19', to: '2026-10-25' })).toBe('19/10 – 25/10');
    expect(rangeText({ from: TODAY, to: TODAY })).toBe('28/10');
  });
});

describe('the calendar (P4.5)', () => {
  it('a month in rows of seven, Monday first', () => {
    const oct = monthGrid('2026-10');
    expect(oct[0]).toEqual([
      null,
      null,
      null,
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(oct.every((r) => r.length === 7)).toBe(true);
    expect(oct.flat().filter(Boolean)).toHaveLength(31);
    expect(oct.at(-1)?.at(-1)).toBe(null); // 31 Oct is a Saturday
    expect(monthGrid('2027-02').flat().filter(Boolean)).toHaveLength(28);
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('first tap, last tap (either order), a third starts again', () => {
    let p = tapDay({}, '2026-10-10');
    expect(p).toEqual({ from: '2026-10-10' });
    p = tapDay(p, '2026-10-05');
    expect(p).toEqual({ from: '2026-10-05', to: '2026-10-10' });
    p = tapDay(p, '2026-10-20');
    expect(p).toEqual({ from: '2026-10-20' });
    expect(tapDay(p, '2026-10-20')).toEqual({ from: '2026-10-20', to: '2026-10-20' });
  });

  it('no day after today, none too old, never a pick past 92 days', () => {
    expect(canTap({}, TODAY, TODAY)).toBe(true);
    expect(canTap({}, '2026-10-29', TODAY)).toBe(false);
    expect(canTap({}, earliestDay(TODAY), TODAY)).toBe(true);
    expect(canTap({}, addDays(earliestDay(TODAY), -1), TODAY)).toBe(false);
    const first = { from: '2026-09-01' };
    expect(canTap(first, addDays('2026-09-01', RANGE_MAX_DAYS - 1), '2027-03-01')).toBe(true);
    expect(canTap(first, addDays('2026-09-01', RANGE_MAX_DAYS), '2027-03-01')).toBe(false);
    expect(canTap(first, addDays('2026-09-01', -RANGE_MAX_DAYS), '2027-03-01')).toBe(false);
    // Whatever he taps that is allowed, the server accepts.
    for (let i = -120; i <= 120; i += 7) {
      const day = addDays('2026-09-01', i);
      const p = tapDay(first, day);
      if (canTap(first, day, TODAY) && p.from && p.to)
        expect(checkDayRange(p.from, p.to, TODAY)).toEqual({ ok: true });
    }
  });
});

describe('the small map (P4.4)', () => {
  const centre = { lat: 17.4474, lng: 78.3762 };
  it('the centre in the middle; north up, east right; the longer side shows the metres asked', () => {
    const v = viewOf(centre, 1800, 360, 200);
    expect(v.at(centre.lat, centre.lng)).toEqual([180, 100]);
    const [x, y] = v.at(centre.lat + 0.001, centre.lng + 0.001);
    expect(x).toBeGreaterThan(180);
    expect(y).toBeLessThan(100);
    expect(v.scale).toBeCloseTo(0.2, 5);
    // 900 m east is the right edge.
    const east = v.at(
      centre.lat,
      centre.lng + 900 / (111_195 * Math.cos((centre.lat * Math.PI) / 180)),
    );
    expect(east[0]).toBeCloseTo(360, 3);
  });

  it('paths leave out what is off the view', () => {
    const v = viewOf(centre, 1800, 360, 200);
    expect(
      pathOf(v, [
        [centre.lat, centre.lng],
        [centre.lat, centre.lng + 0.001],
      ]),
    ).toMatch(/^M180 100L\d+(\.\d)? 100$/);
    expect(
      pathOf(v, [
        [18, 79],
        [18.1, 79.1],
      ]),
    ).toBe('');
    expect(pathOf(v, [[centre.lat, centre.lng]])).toBe('');
    // A long road: only the part near the view.
    const long = Array.from({ length: 200 }, (_, i) => [centre.lat, 78.3 + i * 0.001] as const);
    const d = pathOf(v, long);
    expect(d.split(/[ML]/).filter(Boolean).length).toBeLessThan(30);
  });

  it('how long ago', () => {
    expect(ago(1000, 1000)).toEqual({ n: 1, unit: 'min' });
    expect(ago(10_000, 10_000 - 59 * 60)).toEqual({ n: 59, unit: 'min' });
    expect(ago(10_000, 10_000 - 3 * 3600 - 100)).toEqual({ n: 3, unit: 'h' });
  });
});
