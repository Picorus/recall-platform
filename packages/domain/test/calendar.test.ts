// P3.7: the inventory calendar's sums and a hold's lines.
import { describe, expect, it } from 'vitest';
import {
  calendarDays,
  cellOf,
  deliveredTenths,
  holdLinesOf,
  MAX_HOLD_LINES,
  usualBikes,
} from '../src/calendar.js';
import { DEFAULT_CAPACITY_RULES } from '../src/supply.js';

const NOW = Date.UTC(2027, 7, 23, 4, 30) / 1000; // Mon 23 Aug 2027, 10:00 India time

describe('inventory calendar (P3.7)', () => {
  it('days: a week from any date, across a month end; a date that is not a real day is refused', () => {
    expect(calendarDays('2027-08-29', 4)).toEqual([
      '2027-08-29',
      '2027-08-30',
      '2027-08-31',
      '2027-09-01',
    ]);
    expect(() => calendarDays('2027-02-30', 7)).toThrow(RangeError);
    expect(() => calendarDays('next week', 7)).toThrow(RangeError);
  });

  it('a cell: free is the limit less booked and held, never below 0; no limit means nothing to count', () => {
    const base = {
      date: '2027-08-27',
      startHour: 19,
      booked: 30,
      held: 15,
      forecast: null,
      usual: null,
      delivered: [],
      now: NOW,
    };
    expect(cellOf({ ...base, manualLimit: 50 })).toMatchObject({ limit: 50, free: 5 });
    expect(cellOf({ ...base, manualLimit: 40 })).toMatchObject({ limit: 40, free: 0 });
    expect(cellOf({ ...base, manualLimit: null })).toMatchObject({ limit: null, free: null });
    // A manual limit wins over the forecast; with none, the forecast is the limit.
    expect(cellOf({ ...base, manualLimit: 60, forecast: 100 })).toMatchObject({
      limit: 60,
      free: 15,
    });
    expect(cellOf({ ...base, manualLimit: null, forecast: 100 })).toMatchObject({
      limit: 100,
      free: 55,
    });
    // Delivered only once the hour is over (19:00–20:00 India time = 13:30–14:30 UTC).
    const line = { bikes: 10, plays: 2_000, counted: 1_500 };
    expect(cellOf({ ...base, manualLimit: null, delivered: [line] }).deliveredTenths).toBeNull();
    const after = Date.UTC(2027, 7, 27, 14, 30) / 1000;
    expect(
      cellOf({ ...base, manualLimit: null, delivered: [line], now: after }).deliveredTenths,
    ).toBe(75);
  });

  it('delivered: each line’s bikes × the share of its plays that counted, never above 100%', () => {
    expect(deliveredTenths([])).toBe(0);
    expect(
      deliveredTenths([
        { bikes: 10, plays: 2_000, counted: 2_400 },
        { bikes: 5, plays: 1_000, counted: 333 },
      ]),
    ).toBe(100 + 16);
  });

  it('usual bikes: the level reached in most past weeks, before any margin; none with too little history', () => {
    const week = (date: string, distinctBikes: number, hours: number) => ({
      date,
      distinctBikes,
      bikeSeconds: hours * 3600,
    });
    const weeks = [
      week('2027-07-19', 120, 130),
      week('2027-07-26', 150, 160),
      week('2027-08-02', 90, 100),
      week('2027-08-09', 140, 120),
      week('2027-08-16', 130, 150),
    ];
    // Levels (smaller of bikes and bike-hours): 120, 150, 90, 120, 130 → 4th highest = 120.
    expect(usualBikes(weeks, DEFAULT_CAPACITY_RULES)).toBe(120);
    expect(usualBikes(weeks.slice(0, 3), DEFAULT_CAPACITY_RULES)).toBeNull();
  });

  it('a hold: every chosen day × hour with the same bikes; refuses no bikes, a bad hour, more than a week', () => {
    expect(holdLinesOf('hyd-madhapur', ['2027-08-28', '2027-08-27'], [20, 19], 10)).toEqual([
      { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 19, bikes: 10 },
      { areaId: 'hyd-madhapur', date: '2027-08-27', startHour: 20, bikes: 10 },
      { areaId: 'hyd-madhapur', date: '2027-08-28', startHour: 19, bikes: 10 },
      { areaId: 'hyd-madhapur', date: '2027-08-28', startHour: 20, bikes: 10 },
    ]);
    expect(() => holdLinesOf('a', ['2027-08-27'], [19], 0)).toThrow('Bikes');
    expect(() => holdLinesOf('a', ['2027-08-27'], [7], 5)).toThrow('not a start hour');
    expect(() => holdLinesOf('a', [], [19], 5)).toThrow('at least one');
    expect(() => holdLinesOf('a', ['2027-02-30'], [19], 5)).toThrow(RangeError);
    const eight = calendarDays('2027-08-23', 8);
    const all = Array.from({ length: 18 }, (_, i) => i + 8);
    expect(holdLinesOf('a', eight.slice(0, 7), all, 5)).toHaveLength(MAX_HOLD_LINES);
    expect(() => holdLinesOf('a', eight, all, 5)).toThrow('at most');
  });
});
