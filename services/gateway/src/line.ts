// P2.3.2: what the gateway does with each message from a screen. A hello is answered with the
// cloud's time (the box sets its clock from it, P2.3.1) and recorded as the last contact. An upload
// is stored with storeUpload (P1.2.5: each numbered report once, minute summaries in order) and
// answered with "stored up to N", so the box can forget those. A message refused whole is recorded
// and not answered: nothing is lost, the box keeps it and sends it again. Commands not yet answered
// (P2.12) go again with every hello (the box says hello when its line opens and every 15 minutes).
import {
  lastAppCode,
  pendingCommands,
  recordHello,
  recordRefusal,
  storeUpload,
  updateFor,
} from '@recall/db';
import {
  ackText,
  downTopic,
  parseHello,
  parseUpload,
  parseUpTopic,
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

/** Handles one message from a screen; returns what to send back. */
export async function handleUp(
  pool: Pool,
  topic: string,
  payload: Uint8Array,
  nowMs: number,
  memory?: LineMemory,
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
      await recordHello(pool, screenId, h.app, nowMs);
    // P2.12: commands not yet answered go again each time the line opens (the box does each once).
    // The time reply never waits on them: a failure here only delays commands to the next hello.
    const commands = await pendingCommands(pool, screenId, nowMs).catch(() => [] as string[]);
    // P2.13: a new player version, when this screen is in the rollout's stage (or a rollback).
    const update = await lastAppCode(pool, screenId)
      .then((code) => updateFor(pool, screenId, code, nowMs))
      .catch(() => undefined);
    return [
      { topic: downTopic(screenId, 'time'), payload: timeText(nowMs, h.mono) },
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
