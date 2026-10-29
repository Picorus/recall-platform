// Review of 29 Oct 2026 (P1.1.7): the screen picks its line from its HELD place (15-second hold,
// no flicker along a border), the cloud judges each play's own position. Crossing a shared border,
// the screen must stop carrying the old area's line while its position counts for that line no
// more, or every crossing would waste about 15 s of brand plays ("inside another area").
import { describe, expect, it } from 'vitest';
import { carriedArea, lineCount, placeKey, type AreaVersion } from '../src/areas.js';
import type { Ring } from '../src/geo.js';
import { judgePlay, lineIdOf, type PlayReport } from '../src/plays.js';
import { START, step, type TrackerState } from '../src/screen-tracker.js';

const box = (s: number, w: number, n: number, e: number): Ring => [
  { lat: s, lng: w },
  { lat: s, lng: e },
  { lat: n, lng: e },
  { lat: n, lng: w },
];
const area = (areaId: string, ring: Ring, edgeMeters = 300): AreaVersion => ({
  areaId,
  version: 1,
  name: areaId,
  city: 'Hyderabad',
  ring,
  edgeMeters,
  validFrom: '2026-11-01T00:00:00.000Z',
  draft: false,
  active: true,
});
/** West and East share the border at 78.41; Far has an edge zone of 0 m and nothing beside it. */
const AREAS = [
  area('hyd-west', box(17.4, 78.4, 17.41, 78.41)),
  area('hyd-east', box(17.4, 78.41, 17.41, 78.42)),
  area('hyd-far', box(17.5, 78.5, 17.51, 78.51), 0),
];
const M_LNG = 1 / (111_195 * Math.cos((17.405 * Math.PI) / 180));
/** 18:00 India time, 2 Nov 2026. */
const HOUR = Date.UTC(2026, 10, 2, 12, 30) / 1000;
const line = (areaId: string) => ({
  lineId: lineIdOf('BK-1', areaId, '2026-11-02', 18),
  areaId,
  startsAt: HOUR,
  endsAt: HOUR + 3600,
  plays: 1000,
});
const verdict = (areaId: string, t: number, lat: number, lng: number) => {
  const l = line(areaId);
  const p: PlayReport = {
    kind: 'play',
    keyId: 'k1',
    slot: 'brand',
    ref: l.lineId,
    adId: 'ad-1',
    startAt: t,
    lengthS: 15,
    latE6: Math.round(lat * 1e6),
    lngE6: Math.round(lng * 1e6),
    accuracyM: 5,
    place: `inside:${areaId}@1`,
    people: 0,
    sig: 'MEUCIQDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  };
  const r = judgePlay(p, {
    receivedAt: t + 60,
    signature: 'ok',
    neighbours: [],
    areas: AREAS,
    line: l,
  });
  return r.refused ?? (r.count.counts === 'no' ? r.count.reason : r.count.counts);
};

/** A ride along `lat` from `fromLng` east at `kmh`, one fix a second; what the screen and cloud make of it. */
function ride(lat: number, fromLng: number, seconds: number, kmh: number) {
  let s: TrackerState = START;
  const out: { t: number; held: string; carried: string | undefined; lat: number; lng: number }[] =
    [];
  for (let i = 0; i < seconds; i++) {
    const t = HOUR + 60 + i;
    const lng = fromLng + ((i * kmh) / 3.6) * M_LNG;
    const r = step(s, t, { t, lat, lng, accuracyM: 5 }, AREAS);
    s = r.state;
    const pos = r.second.position;
    if (!pos) continue;
    out.push({
      t,
      held: placeKey(r.second.place),
      carried: carriedArea(r.second.place, pos, AREAS),
      lat: pos.lat,
      lng: pos.lng,
    });
  }
  return out;
}

describe('crossing a shared border (review, 29 Oct 2026)', () => {
  it('at 30 km/h from West into East: no brand play is ever judged "inside another area"', () => {
    // 300 m inside West, riding east across the shared border into East.
    const seconds = ride(17.405, 78.41 - 300 * M_LNG, 100, 30);
    let held = 0;
    for (const x of seconds) {
      if (x.carried) expect(verdict(x.carried, x.t, x.lat, x.lng)).toMatch(/^(inside|edge)$/);
      // The old rule (the held place alone) would have played West's line inside East.
      if (
        x.held === 'inside:hyd-west@1' &&
        lineCount(x, 'hyd-west', AREAS) === 'inside another area'
      ) {
        held += 1;
        expect(x.carried).toBeUndefined();
        expect(verdict('hyd-west', x.t, x.lat, x.lng)).toBe('inside another area');
      }
    }
    // The 15-second hold: about 14 seconds in East while the screen still says West.
    expect(held).toBeGreaterThanOrEqual(13);
    expect(held).toBeLessThanOrEqual(15);
    // Before the border it carried West; after the hold, East.
    expect(seconds[0]?.carried).toBe('hyd-west');
    expect(seconds[seconds.length - 1]?.carried).toBe('hyd-east');
  });

  it('back and forth along the border: whatever is carried counts where it is played', () => {
    // Wobbling 2 m either side of the border: the held place never flickers, and a brand line is
    // carried only where it counts (else RECALL's own ads).
    let s: TrackerState = START;
    for (let i = 0; i < 120; i++) {
      const t = HOUR + 60 + i;
      const lng = 78.41 + (i % 6 < 3 ? -2 : 2) * M_LNG;
      const r = step(s, t, { t, lat: 17.405, lng, accuracyM: 5 }, AREAS);
      s = r.state;
      const pos = r.second.position;
      if (!pos) continue;
      const c = carriedArea(r.second.place, pos, AREAS);
      if (c) expect(verdict(c, t, pos.lat, pos.lng)).toMatch(/^(inside|edge)$/);
    }
  });

  it('leaving an area with no edge zone: its line stops as soon as the bike is out', () => {
    // From inside Far eastwards out of it (0 m edge zone).
    const seconds = ride(17.505, 78.51 - 100 * M_LNG, 40, 30);
    const out = seconds.filter((x) => x.held === 'inside:hyd-far@1' && x.lng > 78.51 + 1 * M_LNG);
    expect(out.length).toBeGreaterThan(5);
    for (const x of out) {
      expect(x.carried).toBeUndefined();
      expect(verdict('hyd-far', x.t, x.lat, x.lng)).toBe("outside the line's area");
    }
    for (const x of seconds)
      if (x.carried) expect(verdict(x.carried, x.t, x.lat, x.lng)).toBe('inside');
  });
});
