// P2.12 in the database: remote commands, each logged (who, why, when), sent again on every
// reconnect until the box answers, and the box's answers as they arrive in its uploads.
import { randomUUID } from 'node:crypto';
import {
  commandText,
  MAX_COMMAND_LIFE_MS,
  type CommandName,
  type CommandResult,
} from '@recall/domain';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './makeups.js';

type Q = Pick<PoolClient, 'query'>;

export interface IssuedCommand {
  readonly id: string;
  /** The message for the screen's down/command topic. */
  readonly text: string;
}

/**
 * Logs a command for a screen and returns its message (the gateway sends it, now and again on each
 * reconnect until the box answers). `lifeMs`: how long it may wait (at most an hour).
 */
export async function issueCommand(
  pool: Pool,
  o: {
    readonly screenId: string;
    readonly command: CommandName;
    readonly value: number | null;
    readonly by: string;
    readonly reason: string;
    readonly nowMs: number;
    readonly lifeMs?: number;
  },
): Promise<IssuedCommand> {
  const id = randomUUID();
  const until = o.nowMs + Math.min(o.lifeMs ?? 10 * 60_000, MAX_COMMAND_LIFE_MS);
  // Built first: a command the screen would refuse is never logged as sent.
  const text = commandText({ id, made: o.nowMs, until, do: o.command, value: o.value });
  await inTransaction(pool, async (c) => {
    await c.query('INSERT INTO screen_inboxes (screen_id) VALUES ($1) ON CONFLICT DO NOTHING', [
      o.screenId,
    ]);
    await c.query(
      `INSERT INTO screen_commands (id, screen_id, command, value, made_at, until, by, reason)
       VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), $7, $8)`,
      [id, o.screenId, o.command, o.value, o.nowMs, until, o.by, o.reason.trim()],
    );
  });
  return { id, text };
}

/** Commands for a screen not yet answered and not expired: sent again when its line opens. */
export async function pendingCommands(
  pool: Pick<Pool, 'query'>,
  screenId: string,
  nowMs: number,
): Promise<string[]> {
  const r = await pool.query<{
    id: string;
    command: CommandName;
    value: number | null;
    made: string;
    until: string;
  }>(
    `SELECT c.id, c.command, c.value,
            (extract(epoch FROM c.made_at) * 1000)::bigint AS made,
            (extract(epoch FROM c.until) * 1000)::bigint AS until
       FROM screen_commands c
      WHERE c.screen_id = $1 AND c.until > to_timestamp($2 / 1000.0)
        AND NOT EXISTS (SELECT 1 FROM screen_command_results r WHERE r.id = c.id)
      ORDER BY c.made_at, c.id`,
    [screenId, nowMs],
  );
  return r.rows.map((x) =>
    commandText({
      id: x.id,
      made: Number(x.made),
      until: Number(x.until),
      do: x.command,
      value: x.value,
    }),
  );
}

/**
 * Stores a box's answer (inside an upload's transaction). An answer to a command this screen was
 * never sent is kept as a report but not as an answer (false).
 */
export async function storeCommandResult(
  c: Q,
  screenId: string,
  seq: number,
  r: CommandResult,
): Promise<boolean> {
  const known = await c.query('SELECT 1 FROM screen_commands WHERE id = $1 AND screen_id = $2', [
    r.id,
    screenId,
  ]);
  if (!known.rowCount) return false;
  await c.query(
    `INSERT INTO screen_command_results (id, screen_id, seq, result, note, at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
    [r.id, screenId, seq, r.result, r.note, r.at],
  );
  return true;
}

export interface CommandLogLine {
  readonly id: string;
  readonly command: CommandName;
  readonly value: number | null;
  readonly by: string;
  readonly reason: string;
  readonly made: number;
  /** The box's first answer, or "waiting" / "expired" while there is none. */
  readonly state: 'done' | 'refused' | 'failed' | 'waiting' | 'expired';
  readonly note: string;
}

/** A screen's commands, newest first, with how each ended: the log admin shows (P3). */
export async function commandLog(
  pool: Pick<Pool, 'query'>,
  screenId: string,
  nowMs: number,
  limit = 100,
): Promise<CommandLogLine[]> {
  const r = await pool.query<{
    id: string;
    command: CommandName;
    value: number | null;
    by: string;
    reason: string;
    made: string;
    expired: boolean;
    result: 'done' | 'refused' | 'failed' | null;
    note: string | null;
  }>(
    `SELECT c.id, c.command, c.value, c.by, c.reason,
            (extract(epoch FROM c.made_at) * 1000)::bigint AS made,
            c.until <= to_timestamp($2 / 1000.0) AS expired,
            a.result, a.note
       FROM screen_commands c
       LEFT JOIN LATERAL (SELECT result, note FROM screen_command_results r
                           WHERE r.id = c.id ORDER BY r.seq LIMIT 1) a ON true
      WHERE c.screen_id = $1
      ORDER BY c.made_at DESC, c.id LIMIT $3`,
    [screenId, nowMs, limit],
  );
  return r.rows.map((x) => ({
    id: x.id,
    command: x.command,
    value: x.value,
    by: x.by,
    reason: x.reason,
    made: Number(x.made),
    state: x.result ?? (x.expired ? 'expired' : 'waiting'),
    note: x.note ?? '',
  }));
}
