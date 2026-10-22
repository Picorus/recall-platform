// Run a simulation from the command line, e.g.
//   pnpm --filter @recall/simulator start -- --scenario rain --bikes 200 --minutes 60 --seed 7
import { parseArgs } from 'node:util';
import { SCENARIOS, simulate } from './simulate.js';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    scenario: { type: 'string', default: 'normal' },
    bikes: { type: 'string', default: '200' },
    minutes: { type: 'string', default: '60' },
    seed: { type: 'string', default: '1' },
  },
});
const scenario = SCENARIOS[values.scenario];
if (!scenario) {
  console.error(`Unknown scenario. Pick one of: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}
const started = Date.now();
const r = simulate({
  scenario,
  bikes: Number(values.bikes),
  seconds: Number(values.minutes) * 60,
  seed: Number(values.seed),
});
const pct = (a: number, b: number) => (b === 0 ? '—' : `${((100 * a) / b).toFixed(1)}%`);
console.log(`Scenario: ${r.scenario} · ${r.bikes} bikes riding · ${r.seconds / 60} minutes`);
console.log(
  `Moving-hour clock: ${(r.clockSeconds / 3600).toFixed(1)} h counted vs ${(r.truthClockSeconds / 3600).toFixed(1)} h true (${pct(r.clockSeconds, r.truthClockSeconds)})`,
);
console.log(
  `Area agreement: ${pct(r.insideAgreed, r.insideSeconds)} of ${r.insideSeconds} seconds inside an area`,
);
console.log(
  `Reports: ${r.reportsMade} made, ${r.reportsStored} stored once, ${r.reportsResent} sent again, ${r.reportsLost} lost`,
);
console.log(`Odd minutes for review: ${r.oddMinutes} · flat batteries: ${r.flatBatteries}`);
console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s`);
