// P2.12: remote commands to a screen (down/command): reboot, blank and unblank, a test pattern for a
// few minutes, set the brightness (or back to automatic), send its logs, clear its cache. Every
// command is logged in admin (who, why, when) and the box answers each one (done, refused, failed)
// through its outbox, like a play, so the answer is never lost.
//
// A command carries its own id and how long it may be carried out (`until`, at most an hour after
// it was made). The box refuses one that has expired or is dated ahead of its trusted time, and
// carries out each id once: the cloud sends it again on every reconnect until the box answers.
// Only the cloud can send on a screen's down topics (the broker's rules, P2.3), and the line is TLS
// with the box's own certificate both ways. The Kotlin player reads the same text (shared cases
// in test-vectors/screen-commands.json).

export const COMMANDS = [
  'reboot',
  'blank',
  'unblank',
  'test-pattern',
  'brightness',
  'send-logs',
  'clear-cache',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface ScreenCommand {
  /** Unique; the box carries out each id once. */
  readonly id: string;
  /** When it was made and until when it may be carried out (cloud ms). */
  readonly made: number;
  readonly until: number;
  readonly do: CommandName;
  /** brightness: percent 1–100, or null for automatic again; test-pattern: seconds 5–600. */
  readonly value: number | null;
}

/** Longest a command may wait to be carried out. */
export const MAX_COMMAND_LIFE_MS = 3_600_000;
const COMMAND_ID = /^[A-Za-z0-9-]{8,64}$/;
const isWhole = (x: unknown, min: number, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;

/** What is wrong with a command, or undefined when the screen will take it. */
export function commandProblem(x: unknown): string | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'not a command';
  const c = x as Record<string, unknown>;
  const keys = ['v', 'id', 'made', 'until', 'do', 'value'];
  if (Object.keys(c).length !== keys.length || !keys.every((k) => Object.hasOwn(c, k)))
    return 'not a command';
  if (c.v !== 1) return 'unknown version';
  if (typeof c.id !== 'string' || !COMMAND_ID.test(c.id)) return 'bad id';
  if (!isWhole(c.made, 1)) return 'bad time';
  if (!isWhole(c.until, 1) || c.until <= c.made || c.until - c.made > MAX_COMMAND_LIFE_MS)
    return 'bad until';
  if (typeof c.do !== 'string' || !(COMMANDS as readonly string[]).includes(c.do))
    return 'unknown command';
  const v = c.value;
  if (c.do === 'brightness') return v === null || isWhole(v, 1, 100) ? undefined : 'bad value';
  if (c.do === 'test-pattern') return isWhole(v, 5, 600) ? undefined : 'bad value';
  return v === null ? undefined : 'bad value';
}

/** The exact text of a command. Throws on what the screen would refuse. */
export function commandText(c: ScreenCommand): string {
  const text = JSON.stringify({
    v: 1,
    id: c.id,
    made: c.made,
    until: c.until,
    do: c.do,
    value: c.value,
  });
  const problem = commandProblem(JSON.parse(text));
  if (problem) throw new RangeError(`command: ${problem}`);
  return text;
}

export function parseCommand(text: string): ScreenCommand | { readonly problem: string } {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { problem: 'not a command' };
  }
  const problem = commandProblem(x);
  if (problem) return { problem };
  const c = x as ScreenCommand;
  return { id: c.id, made: c.made, until: c.until, do: c.do, value: c.value };
}

// ---------------------------------------------------------------- the box's answer

/** The box's answer to a command, sent through its outbox. */
export interface CommandResult {
  readonly kind: 'command';
  readonly id: string;
  /** When it was answered (UTC seconds). */
  readonly at: number;
  readonly result: 'done' | 'refused' | 'failed';
  /** Why refused or failed; for send-logs, the end of the box's log (printable text only). */
  readonly note: string;
}

export const COMMAND_RESULT_FIELDS = ['kind', 'id', 'at', 'result', 'note'] as const;
export const MAX_NOTE = 4_000;

export function checkCommandResultShape(x: Record<string, unknown>): string | undefined {
  if (typeof x.id !== 'string' || !COMMAND_ID.test(x.id)) return 'bad command id';
  if (!isWhole(x.at, 0, 2 ** 32)) return 'bad time';
  if (x.result !== 'done' && x.result !== 'refused' && x.result !== 'failed') return 'bad result';
  if (typeof x.note !== 'string' || x.note.length > MAX_NOTE || !/^[\x20-\x7e\n]*$/.test(x.note))
    return 'bad note';
  return undefined;
}
