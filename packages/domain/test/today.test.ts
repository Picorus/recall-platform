import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lineStartsAt } from '../src/bookings.js';
import { fleetState, hoursToday, todayOf, weekStartOf, type SoldLine } from '../src/today.js';

const NOW = 2_000_000_000;

describe('the Today page rules (P3.2)', () => {
  it('a screen is at the hub, offline, moving or stopped', () => {
    const fitted = { fitted: true, lastHeard: NOW - 60, lastLive: { t: NOW - 60, moving: true } };
    expect(fleetState({ ...fitted, fitted: false }, NOW)).toBe('at-hub');
    expect(fleetState(fitted, NOW)).toBe('moving');
    expect(fleetState({ ...fitted, lastLive: { t: NOW - 60, moving: false } }, NOW)).toBe(
      'stopped',
    );
    // A position older than 5 minutes says nothing about now; a hello alone means stopped.
    expect(fleetState({ ...fitted, lastLive: { t: NOW - 301, moving: true } }, NOW)).toBe(
      'stopped',
    );
    expect(fleetState({ ...fitted, lastLive: null }, NOW)).toBe('stopped');
    expect(fleetState({ ...fitted, lastHeard: NOW - 301 }, NOW)).toBe('offline');
    expect(fleetState({ ...fitted, lastHeard: null }, NOW)).toBe('offline');
  });

  it('the business day shown: the one running, or between 2 and 8 am the one that just ended', () => {
    const at = (date: string, h: number, m = 0) => lineStartsAt({ date, startHour: h }) + m * 60;
    expect(todayOf(at('2027-08-23', 8))).toBe('2027-08-23');
    expect(todayOf(at('2027-08-23', 23, 59))).toBe('2027-08-23');
    expect(todayOf(at('2027-08-23', 25, 30))).toBe('2027-08-23'); // 1:30 am on the 24th
    expect(todayOf(at('2027-08-23', 29))).toBe('2027-08-23'); // 5 am
    expect(todayOf(at('2027-08-24', 7, 59))).toBe('2027-08-23');
    expect(todayOf(at('2027-08-24', 8))).toBe('2027-08-24');
  });

  it('the week starts Monday 00:00 India time', () => {
    const monday = lineStartsAt({ date: '2027-08-23', startHour: 0 });
    expect(weekStartOf(monday)).toBe(monday);
    expect(weekStartOf(monday - 1)).toBe(monday - 7 * 86_400);
    expect(weekStartOf(lineStartsAt({ date: '2027-08-29', startHour: 23 }))).toBe(monday);
  });

  it('hours sold vs delivered', () => {
    const D = '2027-08-23';
    const now = lineStartsAt({ date: D, startHour: 18 }) + 1800;
    const lines: SoldLine[] = [
      { date: D, startHour: 10, bikes: 5, plays: 1000, counted: 1000 },
      { date: D, startHour: 17, bikes: 5, plays: 1000, counted: 900 },
      { date: D, startHour: 16, bikes: 3, plays: 600, counted: 700 }, // more than promised counts once
      { date: D, startHour: 18, bikes: 4, plays: 800, counted: 300 }, // running
      { date: D, startHour: 21, bikes: 2, plays: 400, counted: 0 },
    ];
    expect(hoursToday(lines, now)).toEqual({
      soldBikeHours: 19,
      soldPlays: 3800,
      dueBikeHours: 13,
      duePlays: 2600,
      deliveredBikeHours: 12.5,
      deliveredPlays: 2500,
      runningBikeHours: 4,
    });
  });

  it('property: delivered never exceeds what was due, and is never negative', () => {
    const D = '2027-08-23';
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            startHour: fc.integer({ min: 8, max: 25 }),
            bikes: fc.integer({ min: 1, max: 200 }),
            plays: fc.integer({ min: 0, max: 40_000 }),
            counted: fc.integer({ min: 0, max: 50_000 }),
          }),
          { maxLength: 40 },
        ),
        fc.integer({ min: 0, max: 20 * 3600 }),
        (ls, offset) => {
          const h = hoursToday(
            ls.map((l) => ({ ...l, date: D })),
            lineStartsAt({ date: D, startHour: 8 }) + offset,
          );
          expect(h.deliveredBikeHours).toBeGreaterThanOrEqual(0);
          expect(h.deliveredBikeHours).toBeLessThanOrEqual(h.dueBikeHours);
          expect(h.deliveredPlays).toBeLessThanOrEqual(h.duePlays);
          expect(h.dueBikeHours + h.runningBikeHours).toBeLessThanOrEqual(h.soldBikeHours);
        },
      ),
    );
  });
});
