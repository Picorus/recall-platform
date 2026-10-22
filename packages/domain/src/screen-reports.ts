// P1.2.4–P1.2.5: what the screen sends to the cloud, and how nothing is lost or counted twice.
//  - a live position every 30 seconds (for the fleet map),
//  - a one-minute summary (area, seconds inside, seconds moving, distance, plays, people),
//  - everything numbered and kept on the screen until the cloud confirms it (up to 7 days).
import type { Place } from './areas.js';
import { distanceMeters, type LatLng } from './geo.js';
import type { Second } from './screen-tracker.js';

export const LIVE_EVERY_SECONDS = 30;
export const KEEP_UNSENT_SECONDS = 7 * 24 * 3600;

/** "inside:hyd-madhapur@3", "edge:hyd-madhapur@3" or "outside": a stable key for a place. */
export function placeKey(place: Place): string {
  return place.kind === 'outside' ? 'outside' : `${place.kind}:${place.areaId}@${place.version}`;
}

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
  /** Of those, seconds at each place (rider pay only counts some places). */
  readonly clockAt: Readonly<Record<string, number>>;
  /** Seconds the bike counted as moving. */
  readonly movingSeconds: number;
  /** Distance between cleaned positions, whole metres. */
  readonly distanceM: number;
  /** Plays and people come from the player and the counter (P1.5, P1.8); zero until then. */
  readonly plays: number;
  readonly people: number;
}

export type Report = LivePosition | MinuteSummary;

export interface MinuteBuilder {
  readonly minute: number | undefined;
  readonly secondsAt: Readonly<Record<string, number>>;
  readonly clockSeconds: number;
  readonly clockAt: Readonly<Record<string, number>>;
  readonly movingSeconds: number;
  readonly distance: number;
  readonly last: LatLng | undefined;
  readonly plays: number;
  readonly people: number;
}

export const EMPTY_MINUTE: MinuteBuilder = {
  minute: undefined,
  secondsAt: {},
  clockSeconds: 0,
  clockAt: {},
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
    if (last) distance += distanceMeters(last, s.position);
    last = s.position;
  }
  const builder: MinuteBuilder = {
    minute,
    secondsAt: { ...cur.secondsAt, [key]: (cur.secondsAt[key] ?? 0) + 1 },
    clockSeconds: cur.clockSeconds + (s.clockRuns ? 1 : 0),
    clockAt: s.clockRuns ? { ...cur.clockAt, [key]: (cur.clockAt[key] ?? 0) + 1 } : cur.clockAt,
    movingSeconds: cur.movingSeconds + (s.moving ? 1 : 0),
    distance,
    last,
    plays: cur.plays + plays,
    people: cur.people + people,
  };
  if (s.t % LIVE_EVERY_SECONDS === 0 && s.position) {
    reports.push({ kind: 'live', t: s.t, ...s.position, place: key, moving: s.moving });
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

/** Reports waiting on the screen until the cloud confirms them. */
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
 * never arrived is lost and the cloud stops waiting for it. Returns the reports that are new and now
 * in order (to store and count) and the number to acknowledge. Repeats and old numbers are ignored.
 */
export function receive(
  inbox: Inbox,
  batch: readonly Numbered[],
  oldestHeld?: number,
): { inbox: Inbox; accepted: Numbered[]; ack: number } {
  const ahead = new Map(inbox.ahead);
  for (const n of batch) {
    if (Number.isInteger(n.seq) && n.seq > inbox.upTo && !ahead.has(n.seq)) ahead.set(n.seq, n);
  }
  const accepted: Numbered[] = [];
  let { upTo, lost } = inbox;
  for (;;) {
    const next = ahead.get(upTo + 1);
    if (next) {
      accepted.push(next);
      ahead.delete(next.seq);
      upTo = next.seq;
    } else if (oldestHeld !== undefined && upTo + 1 < oldestHeld) {
      // The screen no longer has this one: count it lost and move on.
      lost += 1;
      upTo += 1;
    } else break;
  }
  return { inbox: { upTo, ahead, lost }, accepted, ack: upTo };
}
