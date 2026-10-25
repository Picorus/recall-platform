// Downloads west Hyderabad's roads from OpenStreetMap and saves them as the simulator's road map
// (data/west-hyderabad-roads.json.gz). Run where the internet is open (a laptop or the GitHub job
// "OSM roads"): pnpm --filter @recall/simulator exec tsx scripts/fetch-osm-roads.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { overpassQuery, roadsFromOverpass, WEST_HYDERABAD_BOX } from '../src/osm.js';

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function fetchRoads(): Promise<unknown> {
  const body = new URLSearchParams({ data: overpassQuery(WEST_HYDERABAD_BOX) });
  let last: unknown;
  for (const url of SERVERS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'User-Agent': 'recall-platform fleet simulator (one-off road download)' },
      });
      if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (e) {
      last = e;
      console.error(`failed: ${String(e)}`);
    }
  }
  throw last;
}

const answer = (await fetchRoads()) as Parameters<typeof roadsFromOverpass>[0];
const data = roadsFromOverpass(answer, WEST_HYDERABAD_BOX, new Date().toISOString());
const out = join(import.meta.dirname, '../data/west-hyderabad-roads.json.gz');
const zipped = gzipSync(JSON.stringify(data), { level: 9 });
writeFileSync(out, zipped);
console.log(
  `${data.points.length / 2} points, ${data.pieces.length / 2} road pieces, ${Math.round(zipped.length / 1024)} KB → ${out}`,
);
