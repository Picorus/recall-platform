// Where every bike is, every 30 seconds for 15 minutes, for the investor demo page (P7.6): the same
// fake bikes on the same real roads as the other runs. Positions are packed small (two 16-bit numbers
// in a box around the roads, and one byte: riding, inside which area), e.g.
//   pnpm --filter @recall/simulator frames -- --bikes 15500 --out frames-15500.json
import { launchAreas, locate } from '@recall/domain';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NORMAL_HABITS, newBike, tick, truthOf, type Bike } from './bike.js';
import { seeded } from './rng.js';
import { defaultRoads } from './road-graph.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    bikes: { type: 'string', default: '200' },
    seed: { type: 'string', default: '7' },
    minutes: { type: 'string', default: '15' },
    every: { type: 'string', default: '30' },
    out: { type: 'string', default: 'frames.json' },
  },
});
const count = Number(values.bikes);
const every = Number(values.every);
const seconds = Number(values.minutes) * 60;
const roads = defaultRoads();
const areas = launchAreas();
const world = seeded(Number(values.seed));
// Tue 24 Aug 2027, 18:00 India time, as the scheduler proof; ten minutes' warm-up spreads the bikes.
const start = Date.UTC(2027, 7, 24, 12, 30) / 1000;
const warm = 600;
let bikes: Bike[] = Array.from({ length: count }, (_, i) =>
  newBike(`sim-${i}`, roads, NORMAL_HABITS, world, start - warm),
);

// The box the positions are packed into: every road point.
let [s, n, w, e] = [90, -90, 180, -180];
for (let i = 0; i < roads.size; i++) {
  const p = roads.position(i);
  [s, n, w, e] = [Math.min(s, p.lat), Math.max(n, p.lat), Math.min(w, p.lng), Math.max(e, p.lng)];
}
const q = (v: number, lo: number, hi: number) =>
  Math.max(0, Math.min(65535, Math.round(((v - lo) / (hi - lo)) * 65535)));

const frames: { riding: number; inside: number; byArea: Record<string, number>; data: string }[] =
  [];
const started = Date.now();
for (let t = -warm; t <= seconds; t++) {
  bikes = bikes.map((b) => tick(roads, b, NORMAL_HABITS, world, start + t));
  if (t < 0 || t % every !== 0) continue;
  const buf = Buffer.alloc(count * 5);
  const byArea: Record<string, number> = {};
  let riding = 0;
  let inside = 0;
  bikes.forEach((b, i) => {
    const truth = truthOf(roads, b, start + t);
    const where = truth.screenOn ? locate(truth.position, areas) : undefined;
    const k = where?.kind === 'inside' ? areas.findIndex((a) => a.areaId === where.areaId) : -1;
    if (k >= 0) {
      inside += 1;
      const id = areas[k]?.areaId ?? '';
      byArea[id] = (byArea[id] ?? 0) + 1;
    }
    if (truth.riding) riding += 1;
    buf.writeUInt16LE(q(truth.position.lat, s, n), i * 5);
    buf.writeUInt16LE(q(truth.position.lng, w, e), i * 5 + 2);
    // Bit 0: riding; bit 1: screen on; bits 2–7: area number + 1 (0 = outside every area).
    buf.writeUInt8((truth.riding ? 1 : 0) | (truth.screenOn ? 2 : 0) | ((k + 1) << 2), i * 5 + 4);
  });
  frames.push({ riding, inside, byArea, data: buf.toString('base64') });
}
writeFileSync(
  values.out,
  JSON.stringify({
    bikes: count,
    every,
    box: { s, n, w, e },
    areas: areas.map((a) => ({ areaId: a.areaId, name: a.name, ring: a.ring })),
    frames,
  }),
);
console.log(
  `${count} bikes · ${frames.length} pictures · ${((Date.now() - started) / 1000).toFixed(0)} s → ${values.out}`,
);
