// P1.2.4–P1.2.5: what the screen sends to the cloud, and how nothing is lost or counted twice.
//  - a live position every 30 seconds (for the fleet map),
//  - a one-minute summary (area, seconds inside, seconds moving, distance, plays, people),
//  - everything numbered and kept on the screen until the cloud confirms it (up to 7 days).
import { placeKey } from './areas.js';
import { checkPlayShape, type PlayReport } from './plays.js';
import { distanceMeters, type LatLng } from './geo.js';
import { inPayZone, POC_PAY_ZONE, type PayZone } from './pay-zone.js';
import type { Second } from './screen-tracker.js';

export const LIVE_EVERY_SECONDS = 30;
export const KEEP_UNSENT_SECONDS = 7 * 24 * 3600;
/** Distance is only added between positions at most this many seconds apart. */
export const MAX_DISTANCE_GAP_SECONDS = 10;

export { placeKey };

export interface LivePosition {
  readonly kind: 'live';
  readonly t: number;
  readonly lat: number;
  readonly lng: number;
  readonly place: string;
  readonly moving: boolean;
}

export interface MinuteSummary {
  readonly kind: 'minute';
  /** First second of the minute (UTC, a multiple of 60). */
  readonly minute: number;
  /** Seconds spent at each place this minute. */
  readonly secondsAt: Readonly<Record<string, number>>;
  /** Seconds the moving-hour clock ran. */
  readonly clockSeconds: number;
  /** Of those, seconds at each place. */
  readonly clockAt: Readonly<Record<string, number>>;
  /** Of those, seconds inside the pay zone in force (what rider pay counts). */
  readonly payClockSeconds: number;
  /** Seconds the bike counted as moving. */
  readonly movingSeconds: number;
  /** Distance between cleaned positions, whole metres. */
  readonly distanceM: number;
  /** Plays and people come from the player and the counter (P1.5, P1.8); zero until then. */
  readonly plays: number;
  readonly people: number;
}

/** Plays (P1.5) travel the same way: numbered, kept until confirmed, never stored twice. */
export type Report = LivePosition | MinuteSummary | PlayReport;

export interface MinuteBuilder {
  readonly minute: number | undefined;
  readonly secondsAt: Readonly<Record<string, number>>;
  readonly clockSeconds: number;
  readonly clockAt: Readonly<Record<string, number>>;
  readonly payClockSeconds: number;
  readonly movingSeconds: number;
  readonly distance: number;
  /** Last cleaned position and its second, to measure distance from. */
  readonly last: (LatLng & { readonly t: number }) | undefined;
  readonly plays: number;
  readonly people: number;
}

export const EMPTY_MINUTE: MinuteBuilder = {
  minute: undefined,
  secondsAt: {},
  clockSeconds: 0,
  clockAt: {},
  payClockSeconds: 0,
  movingSeconds: 0,
  distance: 0,
  last: undefined,
  plays: 0,
  people: 0,
};

function close(b: MinuteBuilder): MinuteSummary | undefined {
  if (b.minute === undefined) return undefined;
  return {
    kind: 'minute',
    minute: b.minute,
    secondsAt: b.secondsAt,
    clockSeconds: b.clockSeconds,
    clockAt: b.clockAt,
    payClockSeconds: b.payClockSeconds,
    movingSeconds: b.movingSeconds,
    distanceM: Math.round(b.distance),
    plays: b.plays,
    people: b.people,
  };
}

/**
 * Adds one tracker second. Returns the reports due now: the finished previous minute when a new
 * minute starts, and a live position on every 30th second that has a position.
 */
export function addSecond(
  b: MinuteBuilder,
  s: Second,
  plays = 0,
  people = 0,
  zone: PayZone = POC_PAY_ZONE,
): { builder: MinuteBuilder; reports: Report[] } {
  const reports: Report[] = [];
  const minute = s.t - (s.t % 60);
  let cur = b;
  if (cur.minute !== minute) {
    const done = close(cur);
    if (done) reports.push(done);
    cur = { ...EMPTY_MINUTE, minute, last: cur.last };
  }
  const key = placeKey(s.place);
  let distance = cur.distance;
  let last = cur.last;
  if (s.position) {
    // No distance across a GPS gap or a reset: the straight line between would be a guess.
    const joined = last && s.t - last.t <= MAX_DISTANCE_GAP_SECONDS && s.fix !== 'reset';
    if (last && joined) distance += distanceMeters(last, s.position);
    last = { ...s.position, t: s.t };
  }
  const builder: MinuteBuilder = {
    minute,
    secondsAt: { ...cur.secondsAt, [key]: (cur.secondsAt[key] ?? 0) + 1 },
    clockSeconds: cur.clockSeconds + (s.clockRuns ? 1 : 0),
    clockAt: s.clockRuns ? { ...cur.clockAt, [key]: (cur.clockAt[key] ?? 0) + 1 } : cur.clockAt,
    // Without a fix this second, the last known position decides (a short GPS gap).
    payClockSeconds:
      cur.payClockSeconds + (s.clockRuns && inPayZone(zone, s.position ?? last, s.place) ? 1 : 0),
    movingSeconds: cur.movingSeconds + (s.moving ? 1 : 0),
    distance,
    last,
    plays: cur.plays + plays,
    people: cur.people + people,
  };
  if (s.t % LIVE_EVERY_SECONDS === 0 && s.position) {
    const { lat, lng } = s.position;
    reports.push({ kind: 'live', t: s.t, lat, lng, place: key, moving: s.moving });
  }
  return { builder, reports };
}

/** Closes the minute in progress (e.g. at shutdown). */
export function flushMinute(b: MinuteBuilder): Report[] {
  const done = close(b);
  return done ? [done] : [];
}

// ---------------------------------------------------------------- store and forward (P1.2.5)

export interface Numbered {
  readonly seq: number;
  readonly report: Report;
  /** When the screen made it (UTC seconds). */
  readonly at: number;
}

/**
 * Reports waiting on the screen until the cloud confirms them. The screen must keep this (with
 * `nextSeq`) in storage that survives a restart: numbers must never start again from 1.
 */
export interface Outbox {
  readonly nextSeq: number;
  readonly waiting: readonly Numbered[];
  /** Reports dropped unsent because they were older than 7 days (should stay 0). */
  readonly expired: number;
}

export const EMPTY_OUTBOX: Outbox = { nextSeq: 1, waiting: [], expired: 0 };

export function enqueue(box: Outbox, reports: readonly Report[], at: number): Outbox {
  const added = reports.map((report, i) => ({ seq: box.nextSeq + i, report, at }));
  const keep = [...box.waiting, ...added];
  const fresh = keep.filter((n) => at - n.at < KEEP_UNSENT_SECONDS);
  return {
    nextSeq: box.nextSeq + reports.length,
    waiting: fresh,
    expired: box.expired + (keep.length - fresh.length),
  };
}

/** The oldest reports to upload, in order. */
export function nextBatch(box: Outbox, max: number): readonly Numbered[] {
  return box.waiting.slice(0, max);
}

/** The smallest number the screen still holds; sent with every upload (see `receive`). */
export function oldestHeld(box: Outbox): number {
  return box.waiting[0]?.seq ?? box.nextSeq;
}

/** The cloud confirmed everything up to and including `seq`: forget it. */
export function acknowledge(box: Outbox, seq: number): Outbox {
  // Never forget more than was actually sent: a wrong or forged ack cannot empty the outbox.
  const highestSent = box.waiting.at(-1)?.seq ?? 0;
  if (!Number.isInteger(seq) || seq > highestSent) return box;
  return { ...box, waiting: box.waiting.filter((n) => n.seq > seq) };
}

/** The cloud's side: accepts each numbered report exactly once, however often it arrives. */
export interface Inbox {
  /** Every report up to here has arrived (or is known lost). */
  readonly upTo: number;
  /** Reports that arrived after a gap, waiting for the gap to fill. */
  readonly ahead: ReadonlyMap<number, Numbered>;
  /** Numbers the screen no longer holds and never delivered (kept past 7 days). Should stay 0. */
  readonly lost: number;
}

export const EMPTY_INBOX: Inbox = { upTo: 0, ahead: new Map(), lost: 0 };

/**
 * Takes a batch. `oldestHeld` is the smallest number the screen still keeps; anything older that
 * never arrived is lost and the cloud stops waiting for it. The claim is only believed up to the
 * smallest number in this batch (the screen proves it holds that one), so a wrong or forged value
 * can never skip reports the screen still has. Returns the reports that are new and now in order
 * (to store and count) and the number to acknowledge. Repeats and old numbers are ignored.
 */
export function receive(
  inbox: Inbox,
  batch: readonly Numbered[],
  oldestHeld?: number,
): { inbox: Inbox; accepted: Numbered[]; ack: number } {
  const ahead = new Map(inbox.ahead);
  const valid = batch.filter((n) => Number.isSafeInteger(n.seq) && n.seq > 0);
  for (const n of valid) {
    if (n.seq > inbox.upTo && !ahead.has(n.seq)) ahead.set(n.seq, n);
  }
  const proven = Math.min(...valid.map((n) => n.seq));
  const skipBelow =
    oldestHeld !== undefined && Number.isSafeInteger(oldestHeld) && Number.isFinite(proven)
      ? Math.min(oldestHeld, proven)
      : 0;
  const accepted: Numbered[] = [];
  let { upTo, lost } = inbox;
  for (;;) {
    const next = ahead.get(upTo + 1);
    if (next) {
      accepted.push(next);
      ahead.delete(next.seq);
      upTo = next.seq;
    } else if (upTo + 1 < skipBelow) {
      // The screen no longer has these: count them lost and move on to the next one we hold.
      const nextHeld = Math.min(skipBelow, ...[...ahead.keys()].filter((k) => k > upTo));
      lost += nextHeld - upTo - 1;
      upTo = nextHeld - 1;
    } else break;
  }
  return { inbox: { upTo, ahead, lost }, accepted, ack: upTo };
}

// ---------------------------------------------------------------- checking what arrives

/** Every field each kind of report may carry, and nothing else (P1.8.1: only numbers leave the chip). */
export const REPORT_FIELDS = {
  live: ['kind', 't', 'lat', 'lng', 'place', 'moving'],
  minute: [
    'kind',
    'minute',
    'secondsAt',
    'clockSeconds',
    'clockAt',
    'payClockSeconds',
    'movingSeconds',
    'distanceM',
    'plays',
    'people',
  ],
  play: [
    'kind',
    'keyId',
    'slot',
    'ref',
    'adId',
    'startAt',
    'lengthS',
    'latE6',
    'lngE6',
    'accuracyM',
    'place',
    'people',
    'sig',
  ],
} as const satisfies Record<Report['kind'], readonly string[]>;

/** Longest text kept from one field of a report that failed its checks. */
const MAX_KEPT_TEXT = 200;

/**
 * What is kept of a report that failed its checks, for a person to look at: the known fields only,
 * each text cut short, and the names (never the values) of any other fields. So a picture sent by
 * mistake, or on purpose, is never stored, not even in part.
 */
export function keptOfRejected(r: unknown): Record<string, unknown> {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return { notAReport: typeof r };
  const x = r as Record<string, unknown>;
  const known: readonly string[] =
    typeof x.kind === 'string' && Object.hasOwn(REPORT_FIELDS, x.kind)
      ? REPORT_FIELDS[x.kind as Report['kind']]
      : ['kind'];
  const cut = (v: unknown): unknown => {
    if (typeof v === 'string') return v.slice(0, MAX_KEPT_TEXT);
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v).slice(0, 20);
      return Object.fromEntries(
        entries.map(([k, s]) => [k.slice(0, MAX_PLACE_KEY), typeof s === 'number' ? s : '?']),
      );
    }
    return '?';
  };
  const kept: Record<string, unknown> = {};
  const others: string[] = [];
  for (const [k, v] of Object.entries(x)) {
    if (known.includes(k)) kept[k] = cut(v);
    else others.push(k.slice(0, MAX_PLACE_KEY));
  }
  if (others.length > 0) kept.otherFields = others.slice(0, 20);
  return kept;
}

/** Most metres a bike can cover in a minute at the jump limit (150 km/h), with room to spare. */
export const MAX_MINUTE_DISTANCE_M = 3_000;
const MAX_PLACE_KEY = 80;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function secondsMap(v: unknown): string | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'not a map of places';
  let total = 0;
  for (const [k, s] of Object.entries(v)) {
    if (k.length === 0 || k.length > MAX_PLACE_KEY || k.includes('\u0000')) return 'bad place key';
    if (!isInt(s, 0, 60)) return 'seconds out of range';
    total += s;
  }
  return total > 60 ? 'more than 60 seconds in a minute' : undefined;
}

/**
 * Checks a report from a screen before anything is stored or counted. Returns what is wrong, or
 * undefined when it is fine. A report that fails is kept aside with its reason and never counted,
 * so one bad report cannot block a screen's uploads.
 */
export function checkReport(r: unknown): string | undefined {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return 'not a report';
  const x = r as Record<string, unknown>;
  // Only the fields below may travel (P1.8.1): a report carrying anything else, a picture from the
  // people counter for example, is refused and its extra fields are never stored.
  const known = REPORT_FIELDS[x.kind as Report['kind']] as readonly string[] | undefined;
  const extra = known && Object.keys(x).find((k) => !known.includes(k));
  if (extra !== undefined) return `unknown field: ${extra.slice(0, MAX_PLACE_KEY)}`;
  if (x.kind === 'live') {
    if (!isInt(x.t, 0, 2 ** 32)) return 'bad time';
    if (typeof x.lat !== 'number' || !(Math.abs(x.lat) <= 90)) return 'bad latitude';
    if (typeof x.lng !== 'number' || !(Math.abs(x.lng) <= 180)) return 'bad longitude';
    if (
      typeof x.place !== 'string' ||
      x.place.length > MAX_PLACE_KEY ||
      x.place.includes('\u0000')
    ) {
      return 'bad place';
    }
    return typeof x.moving === 'boolean' ? undefined : 'bad moving flag';
  }
  if (x.kind === 'minute') {
    if (!isInt(x.minute, 0, 2 ** 32) || x.minute % 60 !== 0)
      return 'minute must start on a whole minute';
    if (!isInt(x.clockSeconds, 0, 60)) return 'clock seconds out of range';
    if (!isInt(x.payClockSeconds, 0, x.clockSeconds)) return 'pay seconds out of range';
    if (!isInt(x.movingSeconds, 0, 60)) return 'moving seconds out of range';
    if (!isInt(x.distanceM, 0, MAX_MINUTE_DISTANCE_M)) return 'distance out of range';
    if (!isInt(x.plays, 0, 60) || !isInt(x.people, 0, 100_000))
      return 'plays or people out of range';
    const at = secondsMap(x.secondsAt);
    if (at) return `secondsAt: ${at}`;
    const clockAt = secondsMap(x.clockAt);
    if (clockAt) return `clockAt: ${clockAt}`;
    const clockTotal = Object.values(x.clockAt as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    return clockTotal === x.clockSeconds ? undefined : 'clockAt does not add up to clock seconds';
  }
  if (x.kind === 'play') return checkPlayShape(x);
  return 'unknown kind';
}
