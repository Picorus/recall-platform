import { describe, expect, it } from 'vitest';
import { pathOf, projector } from '../../lib/area-map';

describe('area shapes as a picture', () => {
  it('fits every shape inside the picture, north up', () => {
    const a = [
      [78.38, 17.44],
      [78.4, 17.44],
      [78.4, 17.46],
    ] as const;
    const at = projector([a], 300, 200);
    for (const p of a.map(at)) {
      expect(p[0]).toBeGreaterThanOrEqual(0);
      expect(p[0]).toBeLessThanOrEqual(300);
      expect(p[1]).toBeGreaterThanOrEqual(0);
      expect(p[1]).toBeLessThanOrEqual(200);
    }
    // North (a higher latitude) is higher on the picture.
    expect(at([78.4, 17.46])[1]).toBeLessThan(at([78.4, 17.44])[1]);
    expect(pathOf(a, at)).toMatch(/^M[\d.]+,[\d.]+ L.* Z$/);
  });
});
