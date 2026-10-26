import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cornersText, indiaToUtc, parseCorners } from '../../lib/areas';

describe('Areas page helpers', () => {
  it('corners read back from their text', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            lat: fc.integer({ min: -90_000_000, max: 90_000_000 }),
            lng: fc.integer({ min: -180_000_000, max: 180_000_000 }),
          }),
          { minLength: 3, maxLength: 30 },
        ),
        (pts) => {
          const ring = pts.map((p) => ({ lat: p.lat / 1e6, lng: p.lng / 1e6 }));
          expect(parseCorners(cornersText(ring))).toEqual({ ring });
        },
      ),
    );
  });

  it('refuses what is not a corner, and fewer than 3', () => {
    expect(parseCorners('17.4, 78.3\n17.5 78.4\n\n17.45,78.5')).toEqual({
      ring: [
        { lat: 17.4, lng: 78.3 },
        { lat: 17.5, lng: 78.4 },
        { lat: 17.45, lng: 78.5 },
      ],
    });
    expect(parseCorners('17.4, 78.3\nnorth, east\n1,2')).toEqual({
      problem: 'Line 2 is not "latitude, longitude"',
    });
    expect(parseCorners('17.4, 78.3\n95, 78.3\n1,2')).toEqual({
      problem: 'Line 2 is not "latitude, longitude"',
    });
    expect(parseCorners('17.4, 78.3')).toEqual({ problem: 'An area needs at least 3 corners' });
  });

  it('India time to UTC', () => {
    expect(indiaToUtc('2026-11-01T06:00')).toBe('2026-11-01T00:30:00.000Z');
    expect(indiaToUtc('2026-11-01T02:00')).toBe('2026-10-31T20:30:00.000Z');
    expect(indiaToUtc('')).toBeUndefined();
  });
});
