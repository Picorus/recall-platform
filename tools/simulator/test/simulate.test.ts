import { describe, expect, it } from 'vitest';
import { osmRoads } from '../src/road-graph.js';
import { gridMap, nodeToLatLng, route, WEST_HYDERABAD } from '../src/roads.js';
import { seeded } from '../src/rng.js';
import { SCENARIOS, simulate } from '../src/simulate.js';

describe('roads', () => {
  it('a route walks the streets one crossing at a time, ending where asked', () => {
    const path = route({ col: 2, row: 3 }, { col: 5, row: 1 }, true);
    expect(path[0]).toEqual({ col: 2, row: 3 });
    expect(path.at(-1)).toEqual({ col: 5, row: 1 });
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      expect(a && b && Math.abs(a.col - b.col) + Math.abs(a.row - b.row)).toBe(1);
    }
  });

  it('the grid covers the six launch areas', () => {
    const ne = nodeToLatLng(WEST_HYDERABAD, {
      col: WEST_HYDERABAD.columns - 1,
      row: WEST_HYDERABAD.rows - 1,
    });
    expect(ne.lat).toBeGreaterThan(17.478);
    expect(ne.lng).toBeGreaterThan(78.45);
  });
});

describe('random numbers', () => {
  it('the same seed gives the same numbers', () => {
    const a = seeded(42);
    const b = seeded(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );
  });
});

function scenarioNamed(name: string) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`no scenario ${name}`);
  return s;
}

const maps = [
  { name: 'street grid', roads: gridMap(), bikes: 20 },
  // More bikes on the real roads: they spread wider, so 20 leave too few seconds in the areas to judge.
  ...(osmRoads() ? [{ name: 'real roads', roads: osmRoads() ?? gridMap(), bikes: 40 }] : []),
];

describe.each(maps)('fleet runs on the $name (P1.10.3)', ({ roads, bikes }) => {
  const run = (name: string, seed = 11) =>
    simulate({ scenario: scenarioNamed(name), bikes, seconds: 40 * 60, seed, roads });

  it('are repeatable from a seed', () => {
    expect(run('normal', 3)).toEqual(run('normal', 3));
  });

  it.each(['normal', 'rain', 'cricket', 'outage'])(
    '%s: every report stored exactly once, none lost; clock within 5% of the truth and never over; areas agree',
    (name) => {
      const r = run(name);
      expect(r.bikes).toBeGreaterThan(5);
      expect(r.reportsStored).toBe(r.reportsMade);
      expect(r.reportsLost).toBe(0);
      expect(r.clockSeconds).toBeLessThanOrEqual(r.truthClockSeconds * 1.01);
      expect(r.clockSeconds).toBeGreaterThanOrEqual(r.truthClockSeconds * 0.95);
      expect(r.insideAgreed / r.insideSeconds).toBeGreaterThan(0.95);
    },
  );

  it('an outage means reports are sent again, but still stored only once', () => {
    const r = run('outage');
    expect(r.reportsResent).toBeGreaterThan(r.reportsMade);
    expect(r.reportsStored).toBe(r.reportsMade);
  });
});
