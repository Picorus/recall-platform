// P2.3: the line between a screen and the cloud (MQTT over TLS, through EMQX). Each screen talks on
// its own topics only: it sends on recall/v1/s/<screen id>/up/<kind> and listens on
// recall/v1/s/<screen id>/down/<kind>. What travels is the upload of P1.2.5: numbered reports
// (`Numbered`) with the smallest number the screen still holds, answered by one number: everything
// up to it is stored (`receive`, `storeUpload`). The box keeps each report until then, up to 7 days.
// The Kotlin player builds the same topics and message text (shared cases in test-vectors/).
import { isScreenId } from './screen-identity.js';
import type { Numbered } from './screen-reports.js';

export const TOPIC_ROOT = 'recall/v1/s';

/** What a screen sends: a hello when the line opens (asks for the time), and uploads. */
export const UP_KINDS = ['hello', 'upload'] as const;
export type UpKind = (typeof UP_KINDS)[number];
/**
 * What the cloud sends to a screen: `files` the ad files to keep (P2.4, ad-files.ts); `areas`, `plan`
 * and `assign` what to play where (P2.6, screen-plan.ts).
 */
export const DOWN_KINDS = ['ack', 'time', 'files', 'areas', 'plan', 'assign', 'command'] as const;
export type DownKind = (typeof DOWN_KINDS)[number];

export const upTopic = (screenId: string, kind: UpKind) => `${TOPIC_ROOT}/${screenId}/up/${kind}`;
export const downTopic = (screenId: string, kind: DownKind) =>
  `${TOPIC_ROOT}/${screenId}/down/${kind}`;

/** The screen and kind of an "up" topic, or undefined when it is not one. */
export function parseUpTopic(topic: string): { screenId: string; kind: UpKind } | undefined {
  const m = /^recall\/v1\/s\/([^/]+)\/up\/([a-z]+)$/.exec(topic);
  const kind = m?.[2] as UpKind | undefined;
  if (!m?.[1] || !kind || !isScreenId(m[1]) || !UP_KINDS.includes(kind)) return undefined;
  return { screenId: m[1], kind };
}

/** May this screen use this topic? Its own up topics to send, its own down topics to listen. */
export function topicAllowed(screenId: string, topic: string, action: 'publish' | 'subscribe') {
  if (!isScreenId(screenId)) return false;
  const own = `${TOPIC_ROOT}/${screenId}/`;
  if (!topic.startsWith(own)) return false;
  const rest = topic.slice(own.length);
  if (action === 'publish') return UP_KINDS.some((k) => rest === `up/${k}`);
  return rest === 'down/#' || DOWN_KINDS.some((k) => rest === `down/${k}`);
}

/** Largest message a screen may send, and most reports in one upload. */
export const MAX_UP_BYTES = 256 * 1024;
export const MAX_BATCH = 500;

/** The exact text of one numbered report, as the Kotlin player stores and sends it. */
export const numberedText = (n: Numbered): string =>
  `{"seq":${n.seq},"at":${n.at},"report":${JSON.stringify(n.report)}}`;

/** The exact text of an upload. */
export const uploadText = (batch: readonly Numbered[], oldestHeld: number): string =>
  `{"v":1,"oldestHeld":${oldestHeld},"batch":[${batch.map(numberedText).join(',')}]}`;

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
/** Exactly these fields, each its own (a field named "at,report" must not pass for two). */
const hasExactly = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k));
const isCount = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= 1;

function readJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * An upload read from its bytes, or the reason it is refused whole. Each report inside is checked
 * later, one by one, by `storeUpload` (a bad one is set aside under its number, the rest count).
 */
export function parseUpload(
  bytes: Uint8Array,
): { readonly batch: Numbered[]; readonly oldestHeld: number } | { readonly problem: string } {
  if (bytes.length > MAX_UP_BYTES) return { problem: 'too big' };
  const x = readJson(bytes);
  if (!isPlainObject(x)) return { problem: 'not a JSON object' };
  if (!hasExactly(x, ['v', 'oldestHeld', 'batch'])) return { problem: 'wrong fields' };
  if (x.v !== 1) return { problem: 'unknown version' };
  if (!isCount(x.oldestHeld)) return { problem: 'bad oldestHeld' };
  if (!Array.isArray(x.batch) || x.batch.length > MAX_BATCH) return { problem: 'bad batch' };
  const batch: Numbered[] = [];
  for (const n of x.batch) {
    if (!isPlainObject(n) || !hasExactly(n, ['seq', 'at', 'report']) || !isCount(n.seq))
      return { problem: 'bad report number' };
    batch.push(n as unknown as Numbered);
  }
  return { batch, oldestHeld: x.oldestHeld };
}

/** A hello: the app version and the box's own counter (ms), echoed back with the cloud's time. */
export function parseHello(
  bytes: Uint8Array,
): { readonly app: string; readonly mono: number } | { readonly problem: string } {
  if (bytes.length > 1024) return { problem: 'too big' };
  const x = readJson(bytes);
  if (!isPlainObject(x) || !hasExactly(x, ['v', 'app', 'mono']) || x.v !== 1)
    return { problem: 'not a hello' };
  if (typeof x.app !== 'string' || !/^[0-9A-Za-z.+-]{1,32}$/.test(x.app))
    return { problem: 'bad app version' };
  if (typeof x.mono !== 'number' || !Number.isSafeInteger(x.mono) || x.mono < 0)
    return { problem: 'bad counter' };
  return { app: x.app, mono: x.mono };
}

export const helloText = (app: string, mono: number) =>
  `{"v":1,"app":${JSON.stringify(app)},"mono":${mono}}`;

/** The cloud's reply to an upload: everything up to `ack` is stored; the box may forget it. */
export const ackText = (ack: number) => `{"ack":${ack}}`;

/**
 * The cloud's time (UTC ms), in reply to a hello. `echo` is the box's counter from the hello, so the
 * box knows how long the round trip took and how far to trust this time.
 */
export const timeText = (utcMs: number, echo: number) => `{"utcMs":${utcMs},"echo":${echo}}`;
