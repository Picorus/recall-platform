// P2.3.2: what the gateway does with each message from a screen. A hello is answered with the
// cloud's time (the box sets its clock from it, P2.3.1) and recorded as the last contact. An upload
// is stored with storeUpload (P1.2.5: each numbered report once, minute summaries in order) and
// answered with "stored up to N", so the box can forget those. A message refused whole is recorded
// and not answered: nothing is lost, the box keeps it and sends it again. Commands not yet answered
// (P2.12) go again with every hello (the box says hello when its line opens and every 15 minutes).
// P7.8: so does the POC months' plan (down/poc), which the box keeps and plays with no network.
// P2.4.2: and the ad files the box must keep (down/files), with fresh signed download links.
import type { FileStore } from '@recall/adapters';
import {
  businessModes,
  fileListText,
  isEnrolledScreen,
  lastAppCode,
  neededAdFiles,
  signAdFiles,
  pendingCommands,
  pocPlans,
  recordHello,
  recordRefusal,
  storeUpload,
  updateFor,
} from '@recall/db';
import {
  ackText,
  downTopic,
  MAX_AD_FILES,
  parseHello,
  parseUpload,
  parseUpTopic,
  pocPlansText,
  timeText,
} from '@recall/domain';
import type { Pool } from 'pg';

/**
 * What the gateway remembers between messages so that a box sending far too often cannot fill the
 * database: a hello or a refusal is recorded at most once a minute per box (review, P2.3.2). The
 * reply (the time) is still sent every time.
 */
export class LineMemory {
  private readonly seen = new Map<string, number>();
  constructor(private readonly everyMs = 60_000) {}
  /** True when this (box, what) was not recorded in the last minute; then it counts as recorded. */
  due(key: string, nowMs: number): boolean {
    const last = this.seen.get(key);
    if (last !== undefined && nowMs - last < this.everyMs) return false;
    this.seen.set(key, nowMs);
    if (this.seen.size > 200_000) this.seen.clear(); // bounded: at worst a few extra rows
    return true;
  }
}

export interface Reply {
  readonly topic: string;
  readonly payload: string;
}

/** What signs the ad files' download links (the file store, P3.9.1); none: no file lists are sent. */
export type AdLinks = Pick<FileStore, 'readLink'>;

/** Handles one message from a screen; returns what to send back. */
export async function handleUp(
  pool: Pool,
  topic: string,
  payload: Uint8Array,
  nowMs: number,
  memory?: LineMemory,
  links?: AdLinks,
): Promise<Reply[]> {
  const where = parseUpTopic(topic);
  if (!where) return []; // the broker only lets screens send on their own up topics
  const { screenId, kind } = where;
  if (kind === 'hello') {
    const h = parseHello(payload);
    if ('problem' in h) {
      if (memory?.due(`r:${kind}:${screenId}`, nowMs) ?? true)
        await recordRefusal(pool, screenId, kind, h.problem, payload.length, nowMs);
      return [];
    }
    if (memory?.due(`h:${screenId}`, nowMs) ?? true)
      await recordHello(pool, screenId, h.app, nowMs, h.code);
    // P2.12: commands not yet answered go again each time the line opens (the box does each once).
    // The time reply never waits on them: a failure here only delays commands to the next hello.
    const commands = await pendingCommands(pool, screenId, nowMs).catch(() => [] as string[]);
    // P2.13: a new player version, when this screen is in the rollout's stage (or a rollback).
    // The version from the hello itself (older players send none: their last health report).
    const update = await (h.code !== null ? Promise.resolve(h.code) : lastAppCode(pool, screenId))
      .then((code) => updateFor(pool, screenId, code, nowMs))
      .catch(() => undefined);
    const poc = await pocMessage(pool, nowMs).catch(() => undefined);
    const files = links
      ? await filesMessage(pool, screenId, nowMs, links).catch(() => undefined)
      : undefined;
    return [
      { topic: downTopic(screenId, 'time'), payload: timeText(nowMs, h.mono) },
      ...(files ? [{ topic: downTopic(screenId, 'files'), payload: files }] : []),
      ...(poc ? [{ topic: downTopic(screenId, 'poc'), payload: poc }] : []),
      ...commands.map((payload) => ({ topic: downTopic(screenId, 'command'), payload })),
      ...(update ? [{ topic: downTopic(screenId, 'update'), payload: update }] : []),
    ];
  }
  const u = parseUpload(payload);
  if ('problem' in u) {
    if (memory?.due(`r:${kind}:${screenId}`, nowMs) ?? true)
      await recordRefusal(pool, screenId, kind, u.problem, payload.length, nowMs);
    return [];
  }
  const stored = await storeUpload(pool, screenId, u.batch, u.oldestHeld, Math.floor(nowMs / 1000));
  return [{ topic: downTopic(screenId, 'ack'), payload: ackText(stored.ack) }];
}

/** The POC months' plan, made at most once a minute for every screen (it is the same for all). */
let pocCache: { minute: number; text: string | undefined } | undefined;
async function pocMessage(pool: Pool, nowMs: number): Promise<string | undefined> {
  const minute = Math.floor(nowMs / 60_000);
  if (pocCache?.minute === minute) return pocCache.text;
  const plans = await pocPlans(pool, Math.floor(nowMs / 1000));
  // Once a POC was ever switched on, the list goes even when empty: a box must be told when the
  // POC's plans are over (the newest message replaces what it holds).
  const ever = plans.length > 0 || (await businessModes(pool)).some((c) => c.mode === 'poc');
  const text = ever ? pocPlansText(plans, nowMs) : undefined;
  pocCache = { minute, text };
  return text;
}

/** The files every screen needs, worked out at most once a minute (the same for all screens). */
const filesCache = new WeakMap<
  Pool,
  { minute: number; needed: Awaited<ReturnType<typeof neededAdFiles>> }
>();
async function neededNow(pool: Pool, nowMs: number) {
  const minute = Math.floor(nowMs / 60_000);
  const cached = filesCache.get(pool);
  if (cached?.minute === minute) return cached.needed;
  const needed = await neededAdFiles(pool, Math.floor(nowMs / 1000));
  filesCache.set(pool, { minute, needed });
  // Review S2: never cut silently: staff see it in the gateway's log (once a minute at most).
  if (needed.left > 0)
    console.error(
      `ad files: ${needed.left} files the screens need do not fit in one list (most ${MAX_AD_FILES}): they wait for a later list`,
    );
  return needed;
}

/**
 * The ad files one screen must keep, with links signed now (P2.4.2), or undefined when none can be
 * sent: a screen we do not know, or a store whose links are not HTTPS (a laptop's fake store behind
 * plain http): an empty list would make a box drop its files, so nothing is sent then.
 */
export async function filesMessage(
  pool: Pool,
  screenId: string,
  nowMs: number,
  links: AdLinks,
): Promise<string | undefined> {
  const now = Math.floor(nowMs / 1000);
  if (!links.readLink('0'.repeat(64), now + 60).startsWith('https://')) return undefined;
  if (!(await isEnrolledScreen(pool, screenId))) return undefined;
  const { files } = await neededNow(pool, nowMs);
  return fileListText(
    signAdFiles(files, (k, u) => links.readLink(k, u), now),
    nowMs,
  );
}

/** A fingerprint of the files the screens need now (no links): it changes when a list must go out. */
export async function filesFingerprint(pool: Pool, nowMs: number): Promise<string> {
  const { files } = await neededNow(pool, nowMs);
  return files.map((f) => `${f.ad}:${f.sha256}:${f.keepUntil}`).join(',');
}

/** The POC months' plan as it stands now (without its time), to see when it changed (S4). */
export async function pocFingerprint(pool: Pool, nowMs: number): Promise<string> {
  return JSON.stringify(await pocPlans(pool, Math.floor(nowMs / 1000)));
}

/** The POC months' plan for every screen now (as with a hello), or undefined when none is sent. */
export const pocMessageNow = (pool: Pool, nowMs: number): Promise<string | undefined> =>
  pocMessage(pool, nowMs);
