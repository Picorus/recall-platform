// The scheduler proof from the command line (P1.4.7), e.g.
//   pnpm --filter @recall/simulator schedule -- --bikes 15500 --sell 0.9 --seed 7
import { parseArgs } from 'node:util';
import { simulateSchedule } from './schedule-sim.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    bikes: { type: 'string', default: '2000' },
    sell: { type: 'string', default: '0.9' },
    seed: { type: 'string', default: '7' },
  },
});
for (const mode of ['live', 'offline'] as const) {
  const started = Date.now();
  const r = simulateSchedule({
    bikes: Number(values.bikes),
    seed: Number(values.seed),
    mode,
    sellShare: Number(values.sell),
  });
  const pct = (a: number, b: number) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(2)}%`);
  console.log(
    `${mode === 'live' ? 'Cloud assigns every minute' : 'No network all hour'} · ${r.bikes} bikes · ${pct(Number(values.sell), 1)} of each area sold`,
  );
  console.log(
    `  Lines fully delivered: ${r.linesMet} of ${r.lines.length} · plays ${r.playsDelivered} of ${r.playsSold} (${pct(r.playsDelivered, r.playsSold)})`,
  );
  const worst = [...r.lines].sort((a, b) => a.delivered / a.plays - b.delivered / b.plays)[0];
  if (worst)
    console.log(
      `  Worst line: ${worst.lineId} ${worst.delivered} of ${worst.plays} plays on ${worst.differentBikes} different bikes (${worst.bikes} sold)`,
    );
  console.log(
    `  Spare brand spots (RECALL's own ads): ${r.spareSpots} · took ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
}
