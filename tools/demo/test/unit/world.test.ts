// The demo's made-up world passes the same rules real data does: riders' phones and plates are
// valid and all different, brand ads can be drawn, ids are unique.
import { numberPlate, templateProblems } from '@recall/domain';
import { describe, expect, it } from 'vitest';
import { BRANDS, riderOf } from '../../src/world.js';

describe('the demo world', () => {
  it('2,000 riders: valid, different phones, plates and ids', () => {
    const riders = Array.from({ length: 2000 }, (_, n) => riderOf(n));
    for (const r of riders) {
      expect(r.phone).toMatch(/^\+91[6-9][0-9]{9}$/);
      expect(numberPlate(r.plate)).toBe(r.plate);
      expect(r.riderId).toMatch(/^RD-\d{6}$/);
    }
    for (const k of ['phone', 'plate', 'riderId'] as const)
      expect(new Set(riders.map((r) => r[k])).size).toBe(riders.length);
  });

  it("every brand's ads can be drawn by the ad maker", () => {
    expect(new Set(BRANDS.map((b) => b.brandId)).size).toBe(BRANDS.length);
    for (const b of BRANDS)
      for (const ad of b.ads)
        expect(templateProblems({ ...ad, qr: '', colour: b.colour, layout: 0 })).toEqual([]);
  });
});
