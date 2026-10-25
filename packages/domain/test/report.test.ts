import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { peopleEstimate } from '../src/people.js';
import {
  busiestStreets,
  campaignReport,
  checkReportRules,
  DEFAULT_REPORT_RULES as RULES,
  heatMap,
  reportSummary,
  type LineForReport,
  type PlacedPlay,
} from '../src/report.js';

const at = (screenId: string, lat: number, lng: number, n: number): PlacedPlay[] =>
  Array.from({ length: n }, () => ({ screenId, latE6: lat * 1e6, lngE6: lng * 1e6 }));

const line = (
  hour: number,
  promised: number,
  hourPlays: PlacedPlay[],
  makeUpPlays: PlacedPlay[] = [],
) =>
  ({
    lineId: `BK-1/hyd-madhapur/2027-09-01/${hour}`,
    areaId: 'hyd-madhapur',
    areaName: 'Madhapur',
    date: '2027-09-01',
    startHour: hour,
    bikes: 5,
    promised,
    hourPlays,
    makeUpPlays,
  }) satisfies LineForReport;

const report = (lines: LineForReport[], streetOf = new Map<string, string>()) =>
  campaignReport({
    bookingId: 'BK-1',
    brandId: 'b-1',
    from: 0,
    until: 3600,
    builtAt: 90_000,
    lines,
    makeUpsOpened: 1,
    streetOf,
    people: peopleEstimate(1_000),
    rules: RULES,
  });

describe('final report (P1.9.1)', () => {
  it('heat map: plays per hexagon, busiest first, the same every time', () => {
    const plays = [...at('a', 17.448, 78.3915, 3), ...at('b', 17.4474, 78.3762, 5)];
    const map = heatMap(plays, 9);
    expect(map.map((c) => c.plays)).toEqual([5, 3]);
    expect(heatMap([...plays].reverse(), 9)).toEqual(map);
    expect(map[0]?.lat).toBeCloseTo(17.4474, 2);
  });

  it('busiest streets add up the hexagons on each street', () => {
    const cells = [
      { cell: 'a', lat: 0, lng: 0, plays: 5 },
      { cell: 'b', lat: 0, lng: 0, plays: 4 },
      { cell: 'c', lat: 0, lng: 0, plays: 7 },
      { cell: 'd', lat: 0, lng: 0, plays: 9 },
    ];
    const names = new Map([
      ['a', 'Road 1'],
      ['b', 'Road 1'],
      ['c', 'Road 2'],
    ]);
    expect(busiestStreets(cells, names, 1)).toEqual([{ name: 'Road 1', plays: 9 }]);
  });

  it('delivered against promised, make-ups, what is missing and the refund', () => {
    const r = report([
      line(10, 1_000, at('a', 17.448, 78.3915, 1_050)),
      {
        ...line(11, 1_000, at('b', 17.448, 78.3915, 600), at('a', 17.448, 78.3915, 100)),
        refund: { paise: 45_000, status: 'under review' },
      },
    ]);
    expect(r).toMatchObject({
      promised: 2_000,
      delivered: 1_750,
      missing: 300,
      deliveredBp: 8_500, // 1,700 of 2,000 promised; the 50 extra plays of the first hour don't make up the second
      bikes: 2,
      makeUps: { opened: 1, plays: 100 },
      refund: { paise: 45_000, status: 'under review' },
    });
    // Found in review: the headline counts what made the promise, not extras from another hour.
    expect(reportSummary(r)[0]).toBe('1,700 of 2,000 plays delivered (85%) on 2 different bikes.');
    expect(reportSummary(r)[1]).toBe('Plus 50 extra plays, free.');
    expect(r.lines.map((l) => [l.delivered, l.madeUp, l.missing])).toEqual([
      [1_050, 0, 0],
      [600, 100, 300],
    ]);
  });

  it('a rejected refund gives nothing back; nothing missing, no refund', () => {
    const rejected = report([
      { ...line(10, 10, []), refund: { paise: 1_000, status: 'rejected' } },
    ]).refund;
    expect(rejected).toEqual({ paise: 0, status: 'rejected' });
    expect(report([line(10, 10, at('a', 17.448, 78.3915, 10))])).toMatchObject({
      refund: undefined,
      deliveredBp: 10_000,
    });
  });

  it('property: the heat map holds every delivered play exactly once', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            screenId: fc.constantFrom('a', 'b', 'c'),
            latE6: fc.integer({ min: 17_300_000, max: 17_550_000 }),
            lngE6: fc.integer({ min: 78_300_000, max: 78_550_000 }),
          }),
          { maxLength: 300 },
        ),
        (plays) => {
          const r = report([line(10, 100, plays)]);
          expect(r.heatMap.reduce((n, c) => n + c.plays, 0)).toBe(r.delivered);
          expect(new Set(r.heatMap.map((c) => c.cell)).size).toBe(r.heatMap.length);
        },
      ),
    );
  });

  it('settings are checked', () => {
    expect(checkReportRules(RULES)).toEqual([]);
    expect(checkReportRules({ ...RULES, afterHours: 0 })).toHaveLength(1);
    expect(checkReportRules({ ...RULES, streetCells: 2, topStreets: 5 })).toHaveLength(1);
  });
});
