// P1.10: run a fleet of fake bikes through the real screen logic and the real upload path, and
// compare what the screens report with what really happened.
import {
  acknowledge,
  addSecond,
  EMPTY_INBOX,
  EMPTY_MINUTE,
  EMPTY_OUTBOX,
  enqueue,
  flushMinute,
  launchAreas,
  locate,
  nextBatch,
  oddMinutes,
  oldestHeld,
  placeKey,
  receive,
  START,
  step,
  type AreaVersion,
  type Inbox,
  type MinuteBuilder,
  type MinuteSummary,
  type Outbox,
  type TrackerState,
} from '@recall/domain';
import {
  gpsOf,
  NORMAL_HABITS,
  newBike,
  tick,
  truthOf,
  type Bike,
  type BikeHabits,
} from './bike.js';
import { WEST_HYDERABAD, type RoadGrid } from './roads.js';
import { seeded } from './rng.js';

export interface Scenario {
  readonly name: string;
  readonly habits: BikeHabits;
  /** Share of the fleet out riding (rain keeps some at home). */
  readonly onDuty: number;
  /** Chance an upload gets through, and the seconds (from the start) when nothing gets through. */
  readonly uploadSuccess: number;
  readonly outage?: readonly [number, number];
}

export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  normal: { name: 'normal day', habits: NORMAL_HABITS, onDuty: 1, uploadSuccess: 0.97 },
  rain: {
    name: 'rain',
    habits: { ...NORMAL_HABITS, speedKmh: [10, 25], poorFixChance: 0.05, signalChance: 0.2 },
    onDuty: 0.6,
    uploadSuccess: 0.9,
  },
  cricket: {
    name: 'cricket match (bikes cluster at the stadium)',
    habits: { ...NORMAL_HABITS, hotspot: { at: { lat: 17.4448, lng: 78.348 }, chance: 0.5 } },
    onDuty: 1,
    uploadSuccess: 0.95,
  },
  outage: {
    name: 'network outage for 30 minutes',
    habits: NORMAL_HABITS,
    onDuty: 1,
    uploadSuccess: 0.97,
    outage: [1200, 3000],
  },
};

export interface RunOptions {
  readonly scenario: Scenario;
  readonly bikes: number;
  readonly seconds: number;
  readonly seed: number;
  /** First second (UTC). Default: Mon 23 Aug 2027, 10:00 India time. */
  readonly start?: number;
  readonly areas?: readonly AreaVersion[];
  readonly grid?: RoadGrid;
}

export interface RunResult {
  readonly scenario: string;
  readonly bikes: number;
  readonly seconds: number;
  /** Clock seconds the cloud received, and what a perfect screen would have counted. */
  readonly clockSeconds: number;
  readonly truthClockSeconds: number;
  /** Seconds the true position was inside an area, and how many of those the screen agreed on. */
  readonly insideSeconds: number;
  readonly insideAgreed: number;
  /** Reports made by screens, stored by the cloud, sent more than once, and lost for good. */
  readonly reportsMade: number;
  readonly reportsStored: number;
  readonly reportsResent: number;
  readonly reportsLost: number;
  /** Minutes the daily check would show a person. */
  readonly oddMinutes: number;
  /** Bikes whose battery ran flat during the run. */
  readonly flatBatteries: number;
}

const UPLOAD_EVERY = 60;
const BATCH = 50;

interface Screen {
  bike: Bike;
  tracker: TrackerState;
  minute: MinuteBuilder;
  outbox: Outbox;
  inbox: Inbox;
  stored: MinuteSummary[];
  made: number;
  resent: number;
  sentSeqs: Set<number>;
}

export function simulate(o: RunOptions): RunResult {
  const grid = o.grid ?? WEST_HYDERABAD;
  const areas = o.areas ?? launchAreas();
  const start = o.start ?? Date.UTC(2027, 7, 23, 4, 30) / 1000;
  const world = seeded(o.seed);
  const s = o.scenario;
  const screens: Screen[] = [];
  for (let i = 0; i < o.bikes; i++) {
    if (!world.chance(s.onDuty)) continue;
    screens.push({
      bike: newBike(`sim-${i}`, grid, s.habits, world, start),
      tracker: START,
      minute: EMPTY_MINUTE,
      outbox: EMPTY_OUTBOX,
      inbox: EMPTY_INBOX,
      stored: [],
      made: 0,
      resent: 0,
      sentSeqs: new Set(),
    });
  }

  let clockSeconds = 0;
  let truthClockSeconds = 0;
  let insideSeconds = 0;
  let insideAgreed = 0;

  const upload = (sc: Screen, i: number) => {
    const batch = nextBatch(sc.outbox, BATCH);
    for (const n of batch) {
      if (sc.sentSeqs.has(n.seq)) sc.resent += 1;
      sc.sentSeqs.add(n.seq);
    }
    const down = s.outage && i >= s.outage[0] && i < s.outage[1];
    if (batch.length === 0 || down || !world.chance(s.uploadSuccess)) return;
    const r = receive(sc.inbox, batch, oldestHeld(sc.outbox));
    sc.inbox = r.inbox;
    for (const n of r.accepted) if (n.report.kind === 'minute') sc.stored.push(n.report);
    // Sometimes the reply is lost on the way back: the screen will send the same reports again.
    if (world.chance(0.98)) sc.outbox = acknowledge(sc.outbox, r.ack);
  };

  for (let i = 0; i < o.seconds; i++) {
    const t = start + i;
    screens.forEach((sc, k) => {
      sc.bike = tick(grid, sc.bike, s.habits, world, t);
      const truth = truthOf(grid, sc.bike, t);
      if (!truth.screenOn) return;
      const fix = gpsOf(grid, sc.bike, s.habits, world, t);
      const r = step(sc.tracker, t, fix, areas);
      sc.tracker = r.state;
      const a = addSecond(sc.minute, r.second);
      sc.minute = a.builder;
      if (a.reports.length > 0) {
        sc.outbox = enqueue(sc.outbox, a.reports, t);
        sc.made += a.reports.length;
      }
      if (truth.riding || truth.stillFor < 600) truthClockSeconds += 1;
      const real = locate(truth.position, areas);
      if (real.kind === 'inside') {
        insideSeconds += 1;
        if (placeKey(real) === placeKey(r.second.place)) insideAgreed += 1;
      }
      if ((i + k) % UPLOAD_EVERY === 0) upload(sc, i);
    });
  }

  // End of the run: close the minute, then let the network work until everything is in.
  let reportsLost = 0;
  let flatBatteries = 0;
  let odd = 0;
  const end = start + o.seconds;
  for (const sc of screens) {
    const last = flushMinute(sc.minute);
    sc.outbox = enqueue(sc.outbox, last, end);
    sc.made += last.length;
    for (let guard = 0; sc.outbox.waiting.length > 0 && guard < 10_000; guard++) {
      const r = receive(sc.inbox, nextBatch(sc.outbox, BATCH), oldestHeld(sc.outbox));
      sc.inbox = r.inbox;
      for (const n of r.accepted) if (n.report.kind === 'minute') sc.stored.push(n.report);
      sc.outbox = acknowledge(sc.outbox, r.ack);
    }
    reportsLost += sc.inbox.lost;
    if (sc.bike.doing.kind === 'dead') flatBatteries += 1;
    clockSeconds += sc.stored.reduce((n, m) => n + m.clockSeconds, 0);
    odd += oddMinutes(sc.stored).length;
  }

  return {
    scenario: s.name,
    bikes: screens.length,
    seconds: o.seconds,
    clockSeconds,
    truthClockSeconds,
    insideSeconds,
    insideAgreed,
    reportsMade: screens.reduce((n, sc) => n + sc.made, 0),
    reportsStored: screens.reduce((n, sc) => n + sc.inbox.upTo - sc.inbox.lost, 0),
    reportsResent: screens.reduce((n, sc) => n + sc.resent, 0),
    reportsLost,
    oddMinutes: odd,
    flatBatteries,
  };
}
