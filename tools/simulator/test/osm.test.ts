import { describe, expect, it } from 'vitest';
import { overpassQuery, roadsFromOverpass, WEST_HYDERABAD_BOX } from '../src/osm.js';

describe('OpenStreetMap roads (P1.10.1 version 2)', () => {
  it('asks only for roads a bike uses, inside the box', () => {
    const q = overpassQuery(WEST_HYDERABAD_BOX);
    expect(q).toContain('residential');
    expect(q).not.toContain('footway');
    expect(q).toContain('(17.38,78.31,17.5,78.48)');
  });

  it('keeps the largest connected part, each piece once, in a fixed order', () => {
    const node = (id: number, lat: number, lon: number) => ({ type: 'node', id, lat, lon });
    const answer = {
      elements: [
        node(1, 17.44, 78.38),
        node(2, 17.441, 78.38),
        node(3, 17.442, 78.381),
        node(4, 17.45, 78.39),
        node(5, 17.451, 78.39),
        { type: 'way', id: 10, nodes: [1, 2, 3] },
        { type: 'way', id: 11, nodes: [3, 2] }, // the same piece again
        { type: 'way', id: 12, nodes: [4, 5] }, // a separate bit: dropped
      ],
    };
    const d = roadsFromOverpass(answer, WEST_HYDERABAD_BOX, '2026-10-25T00:00:00Z');
    expect(d.points).toEqual([1_744_000, 7_838_000, 1_744_100, 7_838_000, 1_744_200, 7_838_100]);
    expect(d.pieces).toEqual([0, 1, 1, 2]);
    expect(d.licence).toContain('OpenStreetMap contributors');
  });
});
