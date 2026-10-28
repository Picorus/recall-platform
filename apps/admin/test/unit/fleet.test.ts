import { describe, expect, it } from 'vitest';
import { areaOf, batteryText, counts, shown, signalText, type FleetScreen } from '../../lib/fleet';

const s = (over: Partial<FleetScreen>): FleetScreen => ({
  screenId: 'SCR-1234567M',
  bike: 'TS09EA1234',
  riderId: 'R-1',
  state: 'moving',
  position: { t: 0, lat: 17.44, lng: 78.39, moving: true, place: 'inside:hyd-madhapur@2' },
  lastHeard: 0,
  app: '0.12.0',
  alerts: [],
  ...over,
});
const all = new Set(['moving', 'stopped', 'offline', 'at-hub'] as const);

describe('fleet map words and filters', () => {
  it('the area of a position', () => {
    expect(areaOf('inside:hyd-madhapur@2')).toBe('hyd-madhapur');
    expect(areaOf('edge:hyd-kondapur@1')).toBe('hyd-kondapur');
    expect(areaOf('outside')).toBeNull();
    expect(areaOf(undefined)).toBeNull();
  });

  it('filters by state, area and plate or screen id', () => {
    expect(shown(s({}), { states: all, area: '', search: '' })).toBe(true);
    expect(
      shown(s({ state: 'offline' }), { states: new Set(['moving']), area: '', search: '' }),
    ).toBe(false);
    expect(shown(s({}), { states: all, area: 'hyd-kondapur', search: '' })).toBe(false);
    expect(shown(s({}), { states: all, area: 'hyd-madhapur', search: 'ts09 ea' })).toBe(true);
    expect(shown(s({}), { states: all, area: '', search: '567m' })).toBe(true);
    // Spaces and dashes do not count.
    expect(shown(s({}), { states: all, area: '', search: ' scr 1234 ' })).toBe(true);
    expect(shown(s({}), { states: all, area: '', search: 'TS-09 EA-1234' })).toBe(true);
    expect(shown(s({}), { states: all, area: '', search: 'KA01' })).toBe(false);
    expect(shown(s({ position: null }), { states: all, area: 'hyd-madhapur', search: '' })).toBe(
      false,
    );
  });

  it('counts by state', () => {
    expect(counts([s({}), s({ state: 'offline' }), s({ state: 'offline' })])).toEqual({
      moving: 1,
      stopped: 0,
      offline: 2,
      'at-hub': 0,
    });
  });

  it('health in words', () => {
    expect(signalText(-80)).toBe('-80 dBm (good)');
    expect(signalText(-95)).toBe('-95 dBm (fair)');
    expect(signalText(-110)).toBe('-110 dBm (weak)');
    expect(signalText(null)).toBe('not known');
    expect(batteryText(76, true)).toBe('76% charging');
    expect(batteryText(12, false)).toBe('12%');
    expect(batteryText(null, null)).toBe('not known');
  });
});
