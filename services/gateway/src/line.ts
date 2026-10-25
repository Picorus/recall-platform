// P2.3.2: what the gateway does with each message from a screen. A hello is answered with the
// cloud's time (the box sets its clock from it, P2.3.1) and recorded as the last contact. An upload
// is stored with storeUpload (P1.2.5: each numbered report once, minute summaries in order) and
// answered with "stored up to N", so the box can forget those. A message refused whole is recorded
// and not answered: nothing is lost, the box keeps it and sends it again.
import { recordHello, recordRefusal, storeUpload } from '@recall/db';
import {
  ackText,
  downTopic,
  parseHello,
  parseUpload,
  parseUpTopic,
  timeText,
} from '@recall/domain';
import type { Pool } from 'pg';

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
): Promise<Reply[]> {
  const where = parseUpTopic(topic);
  if (!where) return []; // the broker only lets screens send on their own up topics
  const { screenId, kind } = where;
  if (kind === 'hello') {
    const h = parseHello(payload);
    if ('problem' in h) {
      await recordRefusal(pool, screenId, kind, h.problem, payload.length, nowMs);
      return [];
    }
    await recordHello(pool, screenId, h.app, nowMs);
    return [{ topic: downTopic(screenId, 'time'), payload: timeText(nowMs, h.mono) }];
  }
  const u = parseUpload(payload);
  if ('problem' in u) {
    await recordRefusal(pool, screenId, kind, u.problem, payload.length, nowMs);
    return [];
  }
  const stored = await storeUpload(pool, screenId, u.batch, u.oldestHeld, Math.floor(nowMs / 1000));
  return [{ topic: downTopic(screenId, 'ack'), payload: ackText(stored.ack) }];
}
