// P1.5: play counting and proof. Hard rule 1: the screen is the truth for plays; each play is signed
// on the screen with its own key, and the cloud never invents one. The cloud checks every play,
// re-checks where it happened against the real area shape, and counts what the promise allows.
import { lineCount, locate, placeKey, publishedAt, type AreaVersion } from './areas.js';
import { isPocRef, pocPlayProblem, type PocPlayContext } from './poc.js';

/** Settings for checking and counting plays (in the price book, versioned). */
export interface PlayRules {
  /** A play may start at most this far after the cloud's clock (screen clocks drift a little). */
  readonly maxAheadSeconds: number;
  /** Plays older than this when they arrive are kept but not counted (the screen keeps 7 days). */
  readonly maxAgeSeconds: number;
  /** One spot is this long; a screen cannot start two plays closer together than this. */
  readonly spotSeconds: number;
  /** A play shorter than this (cut off by a power loss) is kept but not counted. */
  readonly minPlaySeconds: number;
  /** Positions less accurate than this cannot prove where a play happened. */
  readonly maxAccuracyM: number;
  /** Edge-zone plays count up to this share of the line's promised plays (1000 = 10%). */
  readonly edgeShareBp: number;
}

export const DEFAULT_PLAY_RULES: PlayRules = {
  maxAheadSeconds: 120,
  maxAgeSeconds: 7 * 24 * 3600,
  spotSeconds: 15,
  minPlaySeconds: 14,
  maxAccuracyM: 50,
  edgeShareBp: 1_000,
};

// ---------------------------------------------------------------- P1.5.1 the play record

/** One play as the screen made it. Its id is the screen id and the report's sequence number. */
export interface PlayReport {
  readonly kind: 'play';
  /** Which of the screen's keys signed it. */
  readonly keyId: string;
  /** Whose spot it was: a booking line, a make-up, an aggregator, or RECALL's own ad. */
  readonly slot: 'brand' | 'make-up' | 'aggregator' | 'recall';
  /** Booking line id ("booking/area/day/hour"), make-up or aggregator id; "" for RECALL's own ads. */
  readonly ref: string;
  readonly adId: string;
  /** Start of the play (UTC seconds) and how long it ran. */
  readonly startAt: number;
  readonly lengthS: number;
  /** Position at the start, millionths of a degree (whole numbers: the same bytes everywhere). */
  readonly latE6: number;
  readonly lngE6: number;
  readonly accuracyM: number;
  /** Where the screen thought it was ("inside:hyd-madhapur@3", "edge:…", "outside"). */
  readonly place: string;
  /** People counted during the play: an estimate, never billed (P1.8). */
  readonly people: number;
  /** Signature over `playBytes`: ECDSA P-256 with SHA-256, DER, base64. */
  readonly sig: string;
}

/** Booking line id, as plays and the scheduler use it. */
export const lineIdOf = (bookingId: string, areaId: string, date: string, startHour: number) =>
  `${bookingId}/${areaId}/${date}/${startHour}`;

const TEXT = /^[\x20-\x7e]{0,120}$/;

/**
 * The exact bytes a screen signs: a fixed header, then every field on its own line, in a fixed
 * order, whole numbers only. The Kotlin player builds the same string.
 */
export function playBytes(screenId: string, seq: number, p: Omit<PlayReport, 'sig'>): string {
  return [
    'RECALL-PLAY-1',
    screenId,
    seq,
    p.keyId,
    p.slot,
    p.ref,
    p.adId,
    p.startAt,
    p.lengthS,
    p.latE6,
    p.lngE6,
    p.accuracyM,
    p.place,
    p.people,
  ].join('\n');
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isText = (v: unknown, nonEmpty = true): v is string =>
  typeof v === 'string' && TEXT.test(v) && (!nonEmpty || v.length > 0);

/** Shape check of a play report (before its signature is checked). */
export function checkPlayShape(x: Record<string, unknown>): string | undefined {
  if (!isText(x.keyId)) return 'bad key id';
  if (!['brand', 'make-up', 'aggregator', 'recall'].includes(x.slot as string)) return 'bad slot';
  if (!isText(x.ref, x.slot !== 'recall')) return 'bad reference';
  if (!isText(x.adId)) return 'bad ad id';
  if (!isInt(x.startAt, 0, 2 ** 32)) return 'bad start time';
  if (!isInt(x.lengthS, 1, 60)) return 'bad length';
  if (!isInt(x.latE6, -90_000_000, 90_000_000)) return 'bad latitude';
  if (!isInt(x.lngE6, -180_000_000, 180_000_000)) return 'bad longitude';
  if (!isInt(x.accuracyM, 0, 100_000)) return 'bad accuracy';
  if (!isText(x.place)) return 'bad place';
  if (!isInt(x.people, 0, 100_000)) return 'bad people count';
  if (typeof x.sig !== 'string' || !/^[A-Za-z0-9+/]{20,200}={0,2}$/.test(x.sig))
    return 'bad signature format';
  return undefined;
}

// ---------------------------------------------------------------- P1.5.2 the cloud's checks

/** What a play can count for: a booking line, or a make-up of one (P1.6), as the cloud knows it. */
export interface LineForPlays {
  /** Booking line id, or make-up id ("<line id>#1"). */
  readonly lineId: string;
  readonly areaId: string;
  /** Its time window, UTC seconds: [startsAt, endsAt). A line is one hour; a make-up 1–2 hours. */
  readonly startsAt: number;
  readonly endsAt: number;
  /** Plays promised (a line: bikes × plays per bike-hour) or owed (a make-up). */
  readonly plays: number;
  /** The ads its booking runs (its latest choice): a play of any other ad counts for no brand,
   * whatever line it names (P7.1). */
  readonly ads?: readonly string[];
}

/** Why a play is refused outright (not stored as a play at all). */
export type PlayRefusal = 'bad signature' | 'unknown key' | 'overlaps another play';

/** What a stored play counts as. */
export type PlayCount =
  | { readonly counts: 'inside' | 'edge'; readonly lineId: string }
  | { readonly counts: 'no'; readonly reason: string };

export interface PlayContext {
  readonly receivedAt: number;
  /** Did the signature check out against a key of this screen that was not revoked? */
  readonly signature: 'ok' | 'bad' | 'unknown key';
  /** Start times of this screen's plays already stored within one spot of this one. */
  readonly neighbours: readonly number[];
  /** All versions of all areas (the one in force at the play's time is used). */
  readonly areas: readonly AreaVersion[];
  /** The line or make-up the play names, if it exists and counts (ads approved, not called off). */
  readonly line: LineForPlays | undefined;
  /** P7.8: for a play naming a POC month ("poc/<brand>/<YYYY-MM>"), what the cloud knows of it. */
  readonly poc?: PocPlayContext;
}

/**
 * Checks one play (P1.5.2). A refusal means the record is not a play the cloud accepts; otherwise
 * it is stored, with whether it counts and why not. The position is re-checked by the cloud against
 * the area shape in force at that moment, whatever the screen thought.
 */
export function judgePlay(
  p: PlayReport,
  ctx: PlayContext,
  rules: PlayRules = DEFAULT_PLAY_RULES,
): { refused: PlayRefusal } | { refused?: undefined; count: PlayCount; cloudPlace: string } {
  if (ctx.signature === 'unknown key') return { refused: 'unknown key' };
  if (ctx.signature === 'bad') return { refused: 'bad signature' };
  if (ctx.neighbours.some((t) => Math.abs(t - p.startAt) < rules.spotSeconds))
    return { refused: 'overlaps another play' };

  // Where the cloud finds it, against the published areas in force then (kept for the record).
  const at = new Date(p.startAt * 1000).toISOString();
  const published = (id: string) =>
    publishedAt(
      ctx.areas.filter((a) => a.areaId === id),
      at,
    );
  const inForce = [...new Set(ctx.areas.map((a) => a.areaId))].flatMap((id) => {
    const v = published(id);
    return v?.active ? [v] : [];
  });
  const point = { lat: p.latE6 / 1e6, lng: p.lngE6 / 1e6 };
  const here = locate(point, inForce);
  const cloudPlace = placeKey(here);
  const no = (reason: string) => ({ count: { counts: 'no' as const, reason }, cloudPlace });

  // Brand spots count for a booking line; make-up plays (in RECALL spots or on spare bikes) for
  // their make-up. Aggregator and RECALL's own ads count for no brand.
  if (p.slot !== 'brand' && p.slot !== 'make-up') return no(`${p.slot} spot`);
  if (p.startAt > ctx.receivedAt + rules.maxAheadSeconds) return no('screen clock ahead');
  if (p.startAt < ctx.receivedAt - rules.maxAgeSeconds) return no('arrived too late');
  if (p.lengthS < rules.minPlaySeconds) return no('cut short');
  if (p.accuracyM > rules.maxAccuracyM) return no('position not accurate enough');
  // P7.8: a POC play counts for its brand's POC month, inside the POC zone, at most 5 a bike-hour.
  if (isPocRef(p.ref)) {
    const why = ctx.poc ? pocPlayProblem(p, point, here, ctx.poc) : 'not a POC month';
    return why ? no(why) : { count: { counts: 'inside', lineId: p.ref }, cloudPlace };
  }
  const line = ctx.line;
  if (!line || line.lineId !== p.ref)
    return no(p.slot === 'make-up' ? 'not an open make-up' : 'not a sold booking line');
  if (line.ads && !line.ads.includes(p.adId)) return no('not one of its ads');
  if (p.startAt < line.startsAt || p.startAt >= line.endsAt) return no('outside its hour');
  // Inside the line's own area, or in its edge zone where that zone lies outside every area (even
  // where it overlaps a neighbour's edge zone). Neighbours may share a border (P1.1.7), so an edge
  // zone reaches into the neighbour: a play inside another area is never this line's edge play.
  // The same rule the screen uses to stop carrying a line (lineCount, Areas.lineCount).
  const counts = lineCount(point, line.areaId, inForce);
  if (counts === 'inside another area') return no('inside another area');
  if (counts === 'outside') return no("outside the line's area");
  return { count: { counts, lineId: line.lineId }, cloudPlace };
}

// ---------------------------------------------------------------- P1.5.3–4 counting per line

/** A stored play that counts for a line. */
export interface CountedPlay {
  readonly screenId: string;
  readonly startAt: number;
  readonly counts: 'inside' | 'edge';
  readonly people: number;
}

export interface LineTotals {
  /** Plays that count: all inside, edge ones up to the edge share of the promise. */
  readonly plays: number;
  readonly inside: number;
  /** Edge plays received, and how many of them count. */
  readonly edge: number;
  readonly edgeCounted: number;
  /** Different bikes (screens) with at least one counted play. */
  readonly bikes: number;
  /** Different screen-minutes with a counted play inside the area. */
  readonly minutes: number;
  // No people here: totals reach money code. People are only read as a range (people.ts, P1.8).
}

const byTime = <T extends CountedPlay>(plays: readonly T[]): T[] =>
  [...plays].sort(
    (a, b) =>
      a.startAt - b.startAt || (a.screenId < b.screenId ? -1 : a.screenId > b.screenId ? 1 : 0),
  );

/**
 * The plays of a line that count, earliest first: all inside ones, and edge ones up to
 * `edgeShareBp` of the promise (P1.5.3). Used for the line's totals and to share what the line
 * sold between the screens that delivered it (rider pay, P1.7.5).
 */
export function countedPlays<T extends CountedPlay>(
  promised: number,
  plays: readonly T[],
  rules: PlayRules = DEFAULT_PLAY_RULES,
): T[] {
  const edgeCap = Math.floor((promised * rules.edgeShareBp) / 10_000);
  let edge = 0;
  return byTime(plays).filter((p) => {
    if (p.counts !== 'edge') return true;
    if (edge >= edgeCap) return false;
    edge += 1;
    return true;
  });
}

/**
 * Totals for one line (P1.5.3–4). Edge plays count, earliest first, up to `edgeShareBp` of the
 * promised plays. The same plays always give the same totals, in whatever order they come.
 */
export function lineTotals(
  promised: number,
  plays: readonly CountedPlay[],
  rules: PlayRules = DEFAULT_PLAY_RULES,
): LineTotals {
  const sorted = byTime(plays);
  const counted = countedPlays(promised, plays, rules);
  const edgeCounted = counted.filter((p) => p.counts === 'edge').length;
  return {
    plays: counted.length,
    inside: sorted.filter((p) => p.counts === 'inside').length,
    edge: sorted.filter((p) => p.counts === 'edge').length,
    edgeCounted,
    bikes: new Set(counted.map((p) => p.screenId)).size,
    minutes: new Set(
      counted
        .filter((p) => p.counts === 'inside')
        .map((p) => `${p.screenId}|${Math.floor(p.startAt / 60)}`),
    ).size,
  };
}
