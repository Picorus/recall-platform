import { describe, expect, it } from 'vitest';
import { simulateSchedule } from '../src/schedule-sim.js';

// P1.4.7: sell 90% of what each area really carried (the forecast keeps 10% for make-ups) and
// check every line gets all its plays on at least as many different bikes as were sold.
describe('the scheduler delivers (P1.4.7)', () => {
  it('200 bikes, three seeds: every line fully delivered with the cloud assigning every minute', () => {
    for (const seed of [1, 2, 3]) {
      const r = simulateSchedule({ bikes: 200, seed, mode: 'live', sellShare: 0.9 });
      expect(r.lines.length).toBeGreaterThan(0);
      expect(r.linesMet).toBe(r.lines.length);
    }
  }, 120_000);

  it('the same seed gives exactly the same run', () => {
    const a = simulateSchedule({ bikes: 100, seed: 5, mode: 'live', sellShare: 0.9 });
    const b = simulateSchedule({ bikes: 100, seed: 5, mode: 'live', sellShare: 0.9 });
    expect(a).toEqual(b);
  }, 60_000);

  it('2,000 bikes: every line fully delivered, with make-ups owed and an aggregator in RECALL spots; with no network all hour, still 97%+ of plays', () => {
    const live = simulateSchedule({
      bikes: 2000,
      seed: 7,
      mode: 'live',
      sellShare: 0.9,
      makeUpShare: 0.05,
      aggregatorSpots: 2000,
    });
    expect(live.lines.length).toBeGreaterThan(10);
    expect(live.linesMet).toBe(live.lines.length);
    expect(live.makeUpsDelivered).toBe(live.makeUpsOwed);
    expect(live.aggregatorPlayed).toBeGreaterThan(0);
    const offline = simulateSchedule({ bikes: 2000, seed: 7, mode: 'offline', sellShare: 0.9 });
    expect(offline.playsDelivered / offline.playsSold).toBeGreaterThan(0.97);
  }, 300_000);

  it('sold from a different day (as the real forecast is): 99.5%+ of plays, the rest left for make-ups', () => {
    const r = simulateSchedule({
      bikes: 2000,
      seed: 7,
      forecastSeed: 99,
      mode: 'live',
      sellShare: 0.9,
    });
    expect(r.playsDelivered / r.playsSold).toBeGreaterThan(0.995);
  }, 300_000);
});
