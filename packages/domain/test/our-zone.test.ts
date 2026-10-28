import { describe, expect, it } from 'vitest';
import { BLANK_OUTSIDE_OUR_ZONE, BLANK_SPOT, inOurZone, outsideOurZone } from '../src/our-zone.js';

describe('our zone (P2.5, Prateek 28 Oct 2026)', () => {
  const inside = { kind: 'inside', areaId: 'hyd-madhapur', version: 3 } as const;
  const edge = { kind: 'edge', areaId: 'hyd-madhapur', version: 3, metres: 40 } as const;
  const outside = { kind: 'outside' } as const;

  it('regular business: inside an area or its edge zone is ours; outside every area is not', () => {
    expect(inOurZone(inside, undefined)).toBe(true);
    expect(inOurZone(edge, undefined)).toBe(true);
    expect(inOurZone(outside, undefined)).toBe(false);
  });

  it('under a POC month the POC zone decides, whatever the area', () => {
    expect(inOurZone(outside, true)).toBe(true);
    expect(inOurZone(inside, false)).toBe(false);
  });

  it('outside our zone the screen is blank: no ad, no file, not a play', () => {
    expect(BLANK_OUTSIDE_OUR_ZONE).toBe(true);
    expect(outsideOurZone(['r1', 'r2'], 7)).toEqual(BLANK_SPOT);
    expect(BLANK_SPOT).toEqual({ kind: 'blank' });
  });
});
